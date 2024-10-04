// services.js

const axios = require('axios');
const { Chess } = require('chess.js');
const logger = require('./logger');
const { getLastMoveFromPGN, getFenBeforeLastMove } = require('./moveUtils');
const FormData = require('form-data');
const fs = require('fs');

const TOURNAMENT_ID = process.env.TOURNAMENT_ID;

if (!TOURNAMENT_ID) {
  logger.error('TOURNAMENT_ID environment variable is not set');
  process.exit(1);
}

function getTourneyUrl() {
  return `https://1.pool.livechesscloud.com/get/${TOURNAMENT_ID}/tournament.json`;
}

function getIndexUrl(round) {
  return `https://1.pool.livechesscloud.com/get/${TOURNAMENT_ID}/round-${round}/index.json`;
}

function getGameUrl(round, game) {
  return `https://1.pool.livechesscloud.com/get/${TOURNAMENT_ID}/round-${round}/game-${game}.json?poll`;
}

function standardizeResult(result) {
  if (result === null || result === undefined) {
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
      return '1-0';
    case '0-1':
      return '0-1';
    case '1/2-1/2':
      return '1/2-1/2';
    default:
      return 'unknown';
  }
}

function cleanPGN(moves) {
  return moves.map((move) => move.split(' ')[0]).join(' ');
}

async function getLatestRoundNumber() {
  try {
    const tourneyResponse = await axios.get(getTourneyUrl());
    const tourneyData = tourneyResponse.data;

    const rounds = tourneyData.rounds;
    let latestRound = 0;

    // First, check for live rounds
    for (let i = 0; i < rounds.length; i++) {
      if (rounds[i].live > 0) {
        latestRound = i + 1;
        break;
      }
    }

    // If no live rounds, find the last round with games
    if (latestRound === 0) {
      for (let i = rounds.length - 1; i >= 0; i--) {
        if (rounds[i].count > 0) {
          latestRound = i + 1;
          break;
        }
      }
    }

    if (latestRound === 0) {
      throw new Error('No rounds with games found.');
    }

    return latestRound;
  } catch (error) {
    logger.error('Error fetching latest round number:', error);
    throw new Error('Failed to fetch latest round number');
  }
}

async function isRoundLive(round) {
  try {
    const response = await axios.get(getTourneyUrl());
    const data = response.data;

    const rounds = data.rounds;
    if (rounds[round - 1] && rounds[round - 1].live > 0) {
      return true;
    }

    logger.warn(`Round ${round} is not live.`);
    return false;
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

async function getGameState(round, game) {
  try {
    const gameResponse = await axios.get(getGameUrl(round, game));
    const gameData = gameResponse.data;

    const indexResponse = await axios.get(getIndexUrl(round));
    const indexData = indexResponse.data;

    const pairing = indexData.pairings[game - 1];
    if (!pairing) {
      throw new Error(`No pairing found for game ${game} in round ${round}`);
    }

    const chess = new Chess();
    const cleanedPGN = cleanPGN(gameData.moves || []);

    try {
      chess.loadPgn(cleanedPGN);
    } catch (chessError) {
      logger.warn(`Error loading PGN for round ${round}, game ${game}: ${chessError.message}`);
    }

    const lastMoveLAN = getLastMoveFromPGN(cleanedPGN);
    const fenBeforeLastMove = getFenBeforeLastMove(cleanedPGN);

    const whiteName = `${pairing.white?.fname || 'Unknown'} ${pairing.white?.lname || ''}`.trim();
    const blackName = `${pairing.black?.fname || 'Unknown'} ${pairing.black?.lname || ''}`.trim();
    const playerToken = generatePlayerToken(whiteName, blackName);

    return {
      gameId: `${TOURNAMENT_ID}-${round}-${game}-${playerToken}`,
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
    logger.error(`Error fetching game state for game ${game} in round ${round}:`, error);
    throw error;
  }
}

function generatePlayerToken(whiteName, blackName) {
  const combinedNames = `${whiteName}${blackName}`.replace(/\s+/g, '').toLowerCase();
  return combinedNames.slice(0, 8);
}

const COMMENTARY_API_URL = process.env.COMMENTARY_API_URL;

async function fetchCommentary(latestFEN, lastMove, whiteName, blackName) {
  if (
    latestFEN === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' ||
    latestFEN === 'startpos'
  ) {
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
      headers: response.headers,
      data: JSON.stringify(response.data).slice(0, 500),
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
    logger.error('Error fetching commentary:', {
      message: error.message,
      stack: error.stack,
      config: error.config,
      response: error.response
        ? {
            status: error.response.status,
            statusText: error.response.statusText,
            headers: error.response.headers,
            data: JSON.stringify(error.response.data).slice(0, 500),
          }
        : 'No response',
    });
    return null;
  }
}

async function generateAndUploadImage(fen, whiteName, blackName, evaluation, highlightSquares) {
  try {
    // Generate image
    const response = await axios.post(
      process.env.IMAGE_GENERATION_API_URL,
      {
        fen,
        wName: whiteName,
        bName: blackName,
        evaluation,
        highlightSquares,
      },
      {
        responseType: 'arraybuffer',
      }
    );

    if (response.status !== 200) {
      throw new Error(`Image generation failed: ${response.statusText}`);
    }

    const imageBuffer = Buffer.from(response.data, 'binary');

    // Save the image temporarily
    const tempImagePath = `/tmp/chess_image_${Date.now()}.jpg`;
    fs.writeFileSync(tempImagePath, imageBuffer);

    // Upload to WhatsApp
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempImagePath));
    formData.append('type', 'image/jpeg');
    formData.append('messaging_product', 'whatsapp');

    const uploadUrl = `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`;
    const whatsappResponse = await axios.post(uploadUrl, formData, {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      },
    });

    // Delete the temporary file
    fs.unlinkSync(tempImagePath);

    if (whatsappResponse.status !== 200) {
      throw new Error(`WhatsApp upload failed: ${whatsappResponse.statusText}`);
    }

    logger.info('Image generated and uploaded successfully');
    return whatsappResponse.data.id; // This is the media ID
  } catch (error) {
    logger.error('Error generating and uploading image:', error);
    return null;
  }
}

async function getRoundGames(roundNumber) {
  const games = [];
  const MAX_GAMES = 6; // Adjust this based on the maximum number of games per round

  for (let gameNumber = 1; gameNumber <= MAX_GAMES; gameNumber++) {
    try {
      const response = await axios.get(`https://1.pool.livechesscloud.com/get/${TOURNAMENT_ID}/round-${roundNumber}/game-${gameNumber}.json?poll`);
      const gameData = response.data;
      
      if (gameData.result !== "NOTPLAYED") {
        games.push({
          gameId: gameNumber,
          ...gameData
        });
      }
    } catch (error) {
      logger.error(`Error fetching game ${gameNumber} for round ${roundNumber}:`, error);
      // If we get a 404, it means we've reached the end of the games for this round
      if (error.response && error.response.status === 404) {
        break;
      }
    }
  }

  return games;
}

function isCheckmate(fen) {
  const chess = new Chess(fen);
  return chess.isCheckmate();
}

module.exports = {
  getLatestRoundNumber,
  isRoundLive,
  areAllGamesOver,
  getGameState,
  fetchCommentary,
  generateAndUploadImage,
  getRoundGames,
  isCheckmate, // Add this line
};
