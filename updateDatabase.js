// updateDatabase.js

require('dotenv').config();
const { connectToDatabase } = require('./database');
const {
  getLatestRoundNumber,
  getGameState,
  fetchCommentary,
  generateAndUploadImage,
  areAllGamesOver,
  isRoundLive,
} = require('./services');
const logger = require('./logger');
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const CHECK_INTERVAL = 5000; // 5 seconds
const GAMES_TO_MONITOR = [1, 2, 3, 4, 5, 6];

function generatePlayerToken(whiteName, blackName) {
  const combinedNames = `${whiteName}${blackName}`.replace(/\s+/g, '').toLowerCase();
  return combinedNames.slice(0, 8);
}

async function fetchCommentaryWithRetry(latestFEN, lastMove, whiteName, blackName, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      logger.info(`Attempting to fetch commentary (attempt ${i + 1}/${retries})`, {
        latestFEN,
        lastMove,
        whiteName,
        blackName,
      });

      const commentary = await fetchCommentary(latestFEN, lastMove, whiteName, blackName);

      if (!commentary) {
        logger.warn('Received null or undefined commentary');
        continue;
      }

      logger.info('Successfully fetched commentary', {
        commentary: typeof commentary === 'string' ? commentary.slice(0, 100) + '...' : 'Non-string commentary',
      });

      return commentary;
    } catch (error) {
      logger.error(`Error fetching commentary: ${error.message}`, {
        attempt: i + 1,
        latestFEN,
        lastMove,
        whiteName,
        blackName,
      });

      if (i === retries - 1) {
        logger.error('All retry attempts failed for fetching commentary');
        throw error;
      }

      const delay = 5000 * (i + 1);
      logger.info(`Retrying in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logger.error('Failed to fetch valid commentary after all retries');
  return null;
}

async function updateGame(collection, gameState) {
  try {
    const existingGame = await collection.findOne({
      gameId: gameState.gameId,
      tournamentId: TOURNAMENT_ID,
    });

    let update = {
      $set: {
        lastUpdated: new Date(),
        tournamentId: TOURNAMENT_ID,
      },
    };

    let shouldUpdate = false;
    let shouldGenerateCommentaryAndImage = false;

    if (!existingGame || existingGame.latestFEN !== gameState.latestFEN) {
      shouldUpdate = true;
      shouldGenerateCommentaryAndImage = true;
      update.$set = {
        ...update.$set,
        ...gameState,
      };
    }

    if (
      existingGame &&
      (gameState.result !== existingGame.result || gameState.isLive !== existingGame.isLive)
    ) {
      shouldUpdate = true;
      update.$set.result = gameState.result;
      update.$set.isLive = gameState.isLive;
    }

    if (shouldGenerateCommentaryAndImage) {
      const commentary = await fetchCommentaryWithRetry(
        gameState.latestFEN,
        gameState.lastMove,
        gameState.whiteName,
        gameState.blackName
      );

      if (commentary) {
        if (!update.$push) {
          update.$push = {};
        }
        update.$push.commentaries = commentary;

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

    if (shouldUpdate) {
      await collection.updateOne(
        { gameId: gameState.gameId, tournamentId: TOURNAMENT_ID },
        update,
        { upsert: true }
      );
      logger.info(`Updated game ${gameState.gameId}`);
    } else {
      logger.info(`No updates needed for game ${gameState.gameId}. FEN unchanged.`);
    }
  } catch (error) {
    logger.error(`Error updating game ${gameState.gameId}:`, error);
  }
}

async function startDatabaseUpdater() {
  const db = await connectToDatabase();
  const collection = db.collection(process.env.COLLECTION_NAME);

  let currentRound = await getLatestRoundNumber();
  logger.info(`Starting monitoring for round ${currentRound}`);

  while (true) {
    try {
      const allGamesOver = await areAllGamesOver(currentRound);
      if (allGamesOver) {
        logger.info(`All games in round ${currentRound} are over. Checking for next round...`);
        const nextRound = currentRound + 1;

        const roundIsLive = await isRoundLive(nextRound);
        if (roundIsLive) {
          currentRound = nextRound;
          logger.info(`Round ${currentRound} has started. Monitoring new round.`);
        } else {
          logger.info(`Round ${nextRound} has not started yet. Continuing to monitor round ${currentRound}.`);
        }
      }

      for (const gameNumber of GAMES_TO_MONITOR) {
        try {
          const gameState = await getGameState(currentRound, gameNumber);
          await updateGame(collection, gameState);
        } catch (error) {
          logger.error(`Error processing game ${gameNumber} in round ${currentRound}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error in database updater:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
  }
}

module.exports = { startDatabaseUpdater };
