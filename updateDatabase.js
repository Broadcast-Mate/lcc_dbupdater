require('dotenv').config();
const { connectToDatabase } = require('./database');
const {
  getGameState,
  fetchCommentary,
  generateAndUploadImage,
  isRoundLive,
  areAllGamesOver,
  getRoundGames,
  isCheckmate,
  getLatestRoundNumber, // Add this import
} = require('./services');
const { getLastMoveFromPGN } = require('./moveUtils');
const logger = require('./logger');
const axios = require('axios');
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const LIVE_GAME_POLL_INTERVAL = 4000; // 1 second
const ROUND_CHECK_INTERVAL = 60000; // 1 minute
const TOP_BOARDS = 6;

const { MongoClient } = require('mongodb');

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

async function updateFinishedRounds(collection) {
  logger.info('Updating finished rounds on boot up');
  const latestRound = await getLatestRoundNumber();

  for (let roundNumber = 1; roundNumber <= latestRound; roundNumber++) {
    const isLive = await isRoundLive(roundNumber);
    const allGamesOver = await areAllGamesOver(roundNumber);

    if (isLive) {
      logger.info(`Round ${roundNumber} is live. Stopping finished rounds update.`);
      break;
    }

    if (allGamesOver) {
      logger.info(`Updating finished round ${roundNumber}`);
      await updateFinishedRound(collection, roundNumber);
    } else {
      logger.info(`Round ${roundNumber} is not finished. Stopping finished rounds update.`);
      break;
    }
  }
  logger.info('Finished updating finished rounds');
}

async function updateDatabase() {
  let db;
  try {
    logger.info('Connecting to database...');
    db = await connectToDatabase();
    const collection = db.collection(process.env.COLLECTION_NAME);
    logger.info('Connected to database');

    // Update finished rounds on boot up
    await updateFinishedRounds(collection);

    // Main loop for live rounds
    while (true) {
      const latestRound = await getLatestRoundNumber();
      let foundLiveRound = false;

      for (let roundNumber = 1; roundNumber <= latestRound; roundNumber++) {
        const isLive = await isRoundLive(roundNumber);

        if (isLive) {
          logger.info(`Processing live round ${roundNumber}`);
          await pollLiveRound(collection, roundNumber);
          foundLiveRound = true;
          break; // Stop checking further rounds
        }
      }

      if (!foundLiveRound) {
        logger.info('No live rounds found. Waiting before next check.');
        await new Promise(resolve => setTimeout(resolve, ROUND_CHECK_INTERVAL));
      }
    }

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

async function pollLiveRound(collection, roundNumber) {
  logger.info(`Starting to poll live round ${roundNumber}`);
  while (await isRoundLive(roundNumber)) {
    const games = await getRoundGames(roundNumber);
    if (games && games.length > 0) {
      await updateLiveGames(collection, roundNumber, games);
    }
    await new Promise(resolve => setTimeout(resolve, LIVE_GAME_POLL_INTERVAL));
  }
  logger.info(`Round ${roundNumber} is no longer live`);
}

async function updateLiveGames(collection, roundNumber, games) {
  for (const game of games) {
    try {
      const gameState = await getGameState(roundNumber, game.gameId);
      await updateGame(collection, gameState);
      logger.info(`Updated live game ${game.gameId} in round ${roundNumber}`);
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
  logger.info('Starting database updater');
  await updateDatabase();
}

module.exports = { startDatabaseUpdater };