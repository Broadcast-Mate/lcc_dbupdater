require('dotenv').config();
const { connectToDatabase } = require('./database');
const {
  getGameState,
  fetchCommentary,
  generateAndUploadImage,
  isRoundLive,
  areAllGamesOver,
  getRoundGames, // Add this import
} = require('./services');
const { getLastMoveFromPGN } = require('./moveUtils');
const logger = require('./logger');
const axios = require('axios'); // Make sure axios is imported
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const GAME_UPDATE_INTERVAL = 3000; // 3 seconds
const ROUND_CHECK_INTERVAL = 60000; // 1 minute
const TOP_BOARDS = 6;
const TOP_GAMES_COUNT = 6;
const { MongoClient } = require('mongodb');
const { isCheckmate } = require('./services');

async function checkExistingEntries(collection) {
  logger.info('Checking all existing entries for missing commentary and images...');
  const allEntries = await collection.find({}).toArray();

  for (const entry of allEntries) {
    let shouldUpdate = false;
    const update = { $set: {} };

    if (!entry.commentaries || entry.commentaries.length === 0) {
      logger.info(`Adding commentary for game ${entry.gameId}`);
      const commentaryForEntry = await fetchCommentaryWithRetry(
        entry.latestFEN,
        entry.lastMove,
        entry.white.name,
        entry.black.name
      );

      if (commentaryForEntry) {
        update.$push = { commentaries: commentaryForEntry };
        shouldUpdate = true;
      }
    }

    if (!entry.imageMediaId && entry.lastMove && entry.lastMove !== 'initial') {
      logger.info(`Adding image for game ${entry.gameId}`);
      const [fromSquare, toSquare] = entry.lastMove.match(/.{1,2}/g) || [];
      if (fromSquare && toSquare) {
        const imageMediaId = await generateAndUploadImage(
          entry.latestFEN,
          entry.white.name,
          entry.black.name,
          entry.evaluation,
          [fromSquare, toSquare]
        );

        if (imageMediaId) {
          update.$set.imageMediaId = imageMediaId;
          shouldUpdate = true;
        }
      } else {
        logger.warn(`Invalid lastMove for game ${entry.gameId}: ${entry.lastMove}`);
      }
    }

    if (shouldUpdate) {
      await collection.updateOne({ _id: entry._id }, update);
      logger.info(`Updated entry ${entry._id} with missing data`);
    }
  }
}

async function fetchCommentaryWithRetry(latestFEN, lastMove, whiteName, blackName, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      logger.info(`Attempting to fetch commentary (attempt ${i + 1}/${retries})`, {
        latestFEN,
        lastMove,
        whiteName,
        blackName
      });

      const commentary = await fetchCommentary(latestFEN, lastMove, whiteName, blackName);
      
      if (commentary === null || commentary === undefined) {
        logger.warn('Received null or undefined commentary');
        continue;
      }

      logger.info('Successfully fetched commentary', {
        commentary: typeof commentary === 'string' ? commentary.slice(0, 100) + '...' : 'Non-string commentary'
      });

      return commentary;
    } catch (error) {
      const errorInfo = {
        message: error.message,
        stack: error.stack,
        attempt: i + 1,
        latestFEN,
        lastMove,
        whiteName,
        blackName,
        timestamp: new Date().toISOString()
      };

      if (axios.isAxiosError(error)) {
        errorInfo.axiosError = {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          headers: error.response?.headers
        };
      }

      logger.error('Error fetching commentary:', errorInfo);

      if (i === retries - 1) {
        logger.error('All retry attempts failed for fetching commentary');
        throw error;
      }

      const delay = 5000 * (i + 1);
      logger.info(`Retrying in ${delay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  logger.error('Failed to fetch valid commentary after all retries');
  return null;
}

async function updateDatabase() {
  let db;
  try {
    logger.info('Connecting to database...');
    db = await connectToDatabase();
    const collection = db.collection(process.env.COLLECTION_NAME);
    logger.info('Connected to database');

    const MAX_ROUNDS = 35; // Set this to the maximum number of rounds in the tournament

    for (let roundNumber = 1; roundNumber <= MAX_ROUNDS; roundNumber++) {
      logger.info(`Processing round ${roundNumber}`);
      const isLive = await isRoundLive(roundNumber);
      const allGamesOver = await areAllGamesOver(roundNumber);

      if (isLive) {
        logger.info(`Processing live round ${roundNumber}`);
        const games = await getRoundGames(roundNumber);
        if (games && games.length > 0) {
          await updateLiveGames(collection, { roundNumber, games }, TOP_BOARDS);
        }
      } else if (allGamesOver) {
        logger.info(`Processing finished round ${roundNumber}`);
        await updateFinishedRound(collection, roundNumber);
      } else {
        logger.info(`Round ${roundNumber} is not live and not all games are over. Skipping.`);
      }
    }

    logger.info('Checking for missing data in existing entries...');
    await checkExistingEntries(collection);
    logger.info('Finished checking for missing data');

  } catch (error) {
    logger.error('Error in database updater:', error);
  }
}

async function updateFinishedRound(collection, roundNumber) {
  try {
    const games = await getRoundGames(roundNumber);
    
    for (const game of games) {
      try {
        const gameState = await getGameState(roundNumber, game.gameId);
        await updateGame(collection, gameState);
        logger.info(`Updated finished game ${game.gameId} in round ${roundNumber}`);
      } catch (error) {
        logger.error(`Error updating finished game ${game.gameId} in round ${roundNumber}:`, error);
      }
    }
  } catch (error) {
    logger.error(`Error updating finished round ${roundNumber}:`, error);
  }
}

async function updateLiveGames(collection, liveGames, topN) {
  for (let i = 0; i < Math.min(topN, liveGames.games.length); i++) {
    const game = liveGames.games[i];
    try {
      const gameState = await getGameState(liveGames.roundNumber, game.gameId);
      await updateGame(collection, gameState);
      logger.info(`Updated live game ${game.gameId} in round ${gameState.round}`);
    } catch (error) {
      logger.error(`Error updating live game ${game.gameId}:`, error);
    }
  }
}

async function updateGame(collection, gameState) {
  try {
    const existingGame = await collection.findOne({ 
      gameId: gameState.gameId,
      tournamentId: TOURNAMENT_ID
    });
    
    let update = {
      $set: {
        lastUpdated: new Date(),
        tournamentId: TOURNAMENT_ID,
        ...gameState
      }
    };

    let shouldGenerateCommentaryAndImage = false;

    // Check if the FEN has changed (indicating a new move)
    if (!existingGame || existingGame.latestFEN !== gameState.latestFEN) {
      shouldGenerateCommentaryAndImage = true;
    }

    if (shouldGenerateCommentaryAndImage) {
      let commentary;
      if (isCheckmate(gameState.latestFEN)) {
        commentary = {
          commentary: `The game has ended in checkmate. ${gameState.result === '1-0' ? 'White' : 'Black'} wins.`,
          stockfishEval: gameState.result === '1-0' ? 100 : -100
        };
      } else {
        commentary = await fetchCommentaryWithRetry(gameState.latestFEN, gameState.lastMove, gameState.whiteName, gameState.blackName);
      }
      
      if (commentary) {
        update.$push = { commentaries: commentary };
        
        const imageMediaId = await generateAndUploadImage(
          gameState.latestFEN,
          gameState.whiteName,
          gameState.blackName,
          commentary.stockfishEval,
          gameState.lastMove?.match(/.{1,2}/g)
        );

        if (imageMediaId) {
          update.$set.imageMediaId = imageMediaId;
        }
      }
    }

    await collection.updateOne({ gameId: gameState.gameId }, update, { upsert: true });
    logger.info(`Updated game ${gameState.gameId}`);
  } catch (error) {
    logger.error(`Error updating game ${gameState.gameId}:`, error);
  }
}

async function startDatabaseUpdater() {
  logger.info('Starting database updater loop');
  while (true) {
    try {
      logger.info('Database updater iteration started');
      await updateDatabase();
      logger.info('Database updater iteration completed');
    } catch (error) {
      logger.error('Error in database updater:', error);
    }
    logger.info('Waiting for next iteration...');
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

module.exports = { startDatabaseUpdater };