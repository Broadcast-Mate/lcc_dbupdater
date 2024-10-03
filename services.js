// services.js

const axios = require('axios');
const { Chess } = require('chess.js');
const logger = require('./logger');
const { getLastMoveFromPGN, getFenBeforeLastMove } = require('./moveUtils');
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;

function getTourneyUrl() {
  return `https://1.pool.livechesscloud.com/get/${TOURNAMENT_ID}/tournament.json`;
}

function getIndexUrl(round) {
  return `https://1.pool.livechesscloud.com/get/${TOURNAMENT_ID}/round-${round}/index.json`;
}

function getGameUrl(round, game) {
  return `https://1.pool.livechesscloud.com/get/${TOURNAMENT_ID}/round-${round}/game-${game}.json?noCache=${Date.now()}`;
}

function standardizeResult(result) {
  if (!result) {
    return 'ongoing';
  }

  switch (result.toUpperCase()) {
    case 'WHITEWIN':
      return '1-0';
    case 'BLACKWIN':
      return '0-1';
    case 'DRAW':
      return '1/2-1/2';
    case '1-0':
    case '0-1':
    case '1/2-1/2':
      return result;
    default:
      return 'unknown';
  }
}

async function getLatestRoundNumber() {
  try {
    const response = await axios.get(getTourneyUrl());
    const data = response.data;

    const latestRound = data.rounds.reduce((latest, round, index) => {
      return round.count > 0 ? index + 1 : latest;
    }, 0);

    return latestRound;
  } catch (error) {
    logger.error('Error fetching latest round number:', error);
    throw new Error('Failed to fetch latest round number');
  }
}

async function isRoundLive(round) {
  try {
    const indexResponse = await axios.get(getIndexUrl(round));
    const indexData = indexResponse.data;
    return indexData.pairings && indexData.pairings.length > 0;
  } catch (error) {
    logger.warn(`Round ${round} is not live or data is unavailable.`);
    return false;
  }
}

async function areAllGamesOver(round) {
  try {
    const indexResponse = await axios.get(getIndexUrl(round));
    const indexData = indexResponse.data;

    const allGamesOver = indexData.pairings.every((pairing) => {
      return pairing.result && standardizeResult(pairing.result) !== 'ongoing';
    });

    return allGamesOver;
  } catch (error) {
    logger.error(`Error checking if all games are over in round ${round}:`, error);
    return false;
  }
}

async function getGameState(round, gameNumber) {
  try {
    const gameResponse = await axios.get(getGameUrl(round, gameNumber));
    const gameData = gameResponse.data;

    const indexResponse = await axios.get(getIndexUrl(round));
    const indexData = indexResponse.data;

    const pairing = indexData.pairings[gameNumber - 1];
    if (!pairing) {
      throw new Error(`No pairing found for game ${gameNumber} in round ${round}`);
    }

    const chess = new Chess();
    const cleanedPGN = (gameData.moves || []).map((move) => move.split(' ')[0]).join(' ');

    try {
      chess.loadPgn(cleanedPGN);
    } catch (chessError) {
      logger.warn(`Error loading PGN for round ${round}, game ${gameNumber}: ${chessError.message}`);
    }

    const lastMoveLAN = getLastMoveFromPGN(cleanedPGN);
    const fenBeforeLastMove = getFenBeforeLastMove(cleanedPGN);

    const whiteName = `${pairing.white?.fname || 'Unknown'} ${pairing.white?.lname || ''}`.trim();
    const blackName = `${pairing.black?.fname || 'Unknown'} ${pairing.black?.lname || ''}`.trim();
    const playerToken = generatePlayerToken(whiteName, blackName);

    return {
      gameId: `${TOURNAMENT_ID}-${round}-${gameNumber}-${playerToken}`,
      round: round,
      latestFEN: chess.fen() || '',
      fenBeforeLastMove: fenBeforeLastMove || '',
      lastMove: lastMoveLAN || '',
      whiteName,
      blackName,
      whiteFideId: pairing.white?.fideid || '',
      blackFideId: pairing.black?.fideid || '',
      whiteTitle: pairing.white?.title || '',
      blackTitle: pairing.black?.title || '',
      latestPGN: cleanedPGN,
      result: standardizeResult(gameData.result),
      isLive: gameData.live || false,
    };
  } catch (error) {
    logger.error(`Error fetching game state for game ${gameNumber} in round ${round}:`, error);
    throw error;
  }
}

function generatePlayerToken(whiteName, blackName) {
  const combinedNames = `${whiteName}${blackName}`.replace(/\s+/g, '').toLowerCase();
  return combinedNames.slice(0, 8);
}

const COMMENTARY_API_URL = process.env.COMMENTARY_API_URL;

async function fetchCommentary(latestFEN, lastMove, whiteName, blackName) {
  if (latestFEN === 'startpos') {
    logger.info('Initial position, skipping commentary fetch');
    return null;
  }

  try {
    const payload = {
      fen: latestFEN,
      last_move: lastMove,
      white_name: whiteName,
      black_name: blackName,
    };

    logger.info(`Sending request to commentary API: ${COMMENTARY_API_URL}`, payload);

    const response = await axios.post(COMMENTARY_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    logger.info('Received response from commentary API', {
      status: response.status,
      statusText: response.statusText,
      data: response.data,
    });

    if (response.data.error) {
      logger.warn('API returned an error:', response.data.error);
      return null;
    }

    if (!response.data.commentary || typeof response.data.stockfish_eval !== 'number') {
      logger.warn('API response is missing commentary or stockfish_eval', response.data);
      return null;
    }

    return {
      commentary: response.data.commentary,
      stockfishEval: response.data.stockfish_eval,
    };
  } catch (error) {
    logger.error('Error fetching commentary:', error);
    return null;
  }
}

async function generateAndUploadImage(fen, whiteName, blackName, evaluation, highlightSquares) {
  return null; // Placeholder
}

module.exports = {
  getLatestRoundNumber,
  isRoundLive,
  areAllGamesOver,
  getGameState,
  fetchCommentary,
  generateAndUploadImage,
};
