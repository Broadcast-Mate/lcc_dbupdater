require('dotenv').config();
const { connectToDatabase } = require('./database');
const {
  getAvailableRoundsAndGames,
  getGameState,
  getLatestRoundGames,
  getRoundResults,
  fetchCommentary,
  generateAndUploadImage,
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
    db = await connectToDatabase();
    const collection = db.collection(process.env.COLLECTION_NAME);

    // Fetch available rounds and games
    const { roundNumber, games } = await getLatestRoundGames();
    logger.info(`Processing round ${roundNumber}`);

    if (games && games.length > 0) {
      await updateLiveGames(collection, { roundNumber, games }, TOP_BOARDS);
    } else {
      logger.info(`Round ${roundNumber} has no live games. Updating top ${TOP_GAMES_COUNT} games from previous round.`);
      await updatePreviousRound(collection, roundNumber - 1, TOP_GAMES_COUNT);
    }

    // Additional logic for updating database...

  } catch (error) {
    logger.error('Error in database updater:', error);
  }
  // We don't need to close the connection here, as it's managed by the connectToDatabase function
}

async function updateLiveGames(collection, liveGames, topN) {
  for (let i = 0; i < Math.min(topN, liveGames.games.length); i++) {
    const game = liveGames.games[i];
    if (game.isLive) {
      try {
        const gameState = await getGameState(liveGames.roundNumber, game.gameNumber);
        await updateGame(collection, gameState);
        logger.info(`Updated live game ${game.gameNumber} in round ${gameState.round}`);
      } catch (error) {
        logger.error(`Error updating live game ${game.gameNumber}:`, error);
      }
    }
  }
}

async function updatePreviousRound(collection, roundNumber, topGamesCount) {
  const { games } = await getLatestRoundGames();
  const topGames = games.slice(0, topGamesCount);
  
  for (const game of topGames) {
    try {
      const gameState = await getGameState(roundNumber, game.gameNumber);
      gameState.result = game.result; // Add the result from the game data
      await updateGame(collection, gameState);
      logger.info(`Updated game ${game.gameNumber} in round ${gameState.round}`);
    } catch (error) {
      logger.error(`Error updating game ${game.gameNumber} in round ${roundNumber}:`, error);
    }
  }
}

async function updateGame(collection, gameState) {
  try {
    const existingGame = await collection.findOne({ 
      gameId: gameState.gameId,
      tournamentId: process.env.TOURNAMENT_ID // Add this line
    });
    
    let update = {
      $set: {
        lastUpdated: new Date(),
        tournamentId: process.env.TOURNAMENT_ID // Add this line
      }
    };

    let shouldUpdate = false;
    let shouldGenerateCommentaryAndImage = false;

    // Check if the FEN has changed (indicating a new move)
    if (!existingGame || existingGame.latestFEN !== gameState.latestFEN) {
      shouldUpdate = true;
      shouldGenerateCommentaryAndImage = true;
      update.$set = {
        ...update.$set,
        ...gameState
      };
    }

    // Always update these fields even if FEN hasn't changed
    if (gameState.result !== existingGame?.result || gameState.isLive !== existingGame?.isLive) {
      shouldUpdate = true;
      update.$set.result = gameState.result;
      update.$set.isLive = gameState.isLive;
    }

    if (shouldGenerateCommentaryAndImage) {
      const commentary = await fetchCommentary(gameState.latestFEN, gameState.lastMove, gameState.wName, gameState.bName);
      
      if (commentary) {
        update.$push = { commentaries: commentary };
        
        const imageMediaId = await generateAndUploadImage(
          gameState.latestFEN,
          gameState.wName,
          gameState.bName,
          commentary.stockfishEval,
          gameState.lastMove?.match(/.{1,2}/g)
        );

        if (imageMediaId) {
          update.$set.imageMediaId = imageMediaId;
        }
      }
    }

    if (shouldUpdate) {
      await collection.updateOne({ gameId: gameState.gameId }, update, { upsert: true });
      logger.info(`Updated game ${gameState.gameId}`);
    } else {
      logger.info(`No updates needed for game ${gameState.gameId}. FEN unchanged.`);
    }
  } catch (error) {
    logger.error(`Error updating game ${gameState.gameId}:`, error);
  }
}

async function startDatabaseUpdater() {
  while (true) {
    try {
      logger.info('Database updater started');
      await updateDatabase();
    } catch (error) {
      logger.error('Error in database updater:', error);
    }
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

module.exports = { startDatabaseUpdater };