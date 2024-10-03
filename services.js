const axios = require('axios');
const { Chess } = require('chess.js');
const logger = require('./logger');
const { getLastMoveFromPGN, getFenBeforeLastMove } = require('./moveUtils');
const FormData = require('form-data');
const fs = require('fs');


const tournamentId = process.env.TOURNAMENT_ID;

if (!tournamentId) {
  logger.error('TOURNAMENT_ID environment variable is not set');
  process.exit(1);
}

function getTourneyUrl() {
  return `https://1.pool.livechesscloud.com/get/${tournamentId}/tournament.json`;
}

function getIndexUrl(round) {
  return `https://1.pool.livechesscloud.com/get/${tournamentId}/round-${round}/index.json`;
}

function getGameUrl(round, game) {
  return `https://1.pool.livechesscloud.com/get/${tournamentId}/round-${round}/game-${game}.json?poll`;
}

function standardizeResult(result) {
  if (result === null || result === undefined) {
    return 'ongoing';
  }

  switch (result.toUpperCase()) {
    case 'WHITEWIN': return '1-0';
    case 'BLACKWIN': return '0-1';
    case 'DRAW': return '1/2-1/2';
    case '1-0': return '1-0';
    case '0-1': return '0-1';
    case '1/2-1/2': return '1/2-1/2';
    default: return 'unknown';
  }
}

function cleanPGN(moves) {
  return moves.map(move => move.split(' ')[0]).join(' ');
}

// Add this new function at the top of the file
async function getLatestRoundNumber() {
  try {
    const tourneyResponse = await axios.get(getTourneyUrl());
    const tourneyData = tourneyResponse.data;

    // Find the latest round with games
    const latestRound = tourneyData.rounds.reduce((latest, round, index) => {
      return round.count > 0 ? index + 1 : latest;
    }, 0);

    return latestRound;
  } catch (error) {
    logger.error('Error fetching latest round number:', error);
    throw new Error('Failed to fetch latest round number');
  }
}

// Service 1: Get available rounds and games for a tournament
async function getAvailableRoundsAndGames() {
  try {
    const tourneyResponse = await axios.get(getTourneyUrl());
    const tourneyData = tourneyResponse.data;

    const availableRounds = [];
    for (let i = 0; i < tourneyData.rounds.length; i++) {
      if (tourneyData.rounds[i].count > 0) {
        try {
          const roundResponse = await axios.get(getIndexUrl(i + 1));
          const roundData = roundResponse.data;
          availableRounds.push({
            round: i + 1,
            games: roundData.pairings.length,
            date: roundData.date
          });
        } catch (error) {
          logger.error(`Error fetching round ${i + 1} data:`, error);
        }
      }
    }

    return {
      tournamentName: tourneyData.name,
      availableRounds: availableRounds
    };
  } catch (error) {
    logger.error('Error:', error);
    throw new Error('An error occurred while fetching tournament data');
  }
}

// Service 2: Get current state of a specific game
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

    const wName = `${pairing.white?.fname || 'Unknown'} ${pairing.white?.lname || ''}`.trim();
    const bName = `${pairing.black?.fname || 'Unknown'} ${pairing.black?.lname || ''}`.trim();
    const playerToken = generatePlayerToken(wName, bName);

    return {
      gameId: `${tournamentId}-${round}-${game}-${playerToken}`,
      round: round,
      latestFEN: chess.fen() || '',
      fenBeforeLastMove: fenBeforeLastMove || '',
      lastMove: lastMoveLAN || '',
      wName,
      bName,
      wFide: pairing.white?.fideid || '',
      bFide: pairing.black?.fideid || '',
      wTitle: pairing.white?.title || '',
      bTitle: pairing.black?.title || '',
      latestPGN: cleanedPGN,
      result: standardizeResult(gameData.result),
      isLive: gameData.live || false
    };
  } catch (error) {
    logger.error('Error fetching game data:', error.message);
    if (error.response) {
      logger.error('Server responded with:', error.response.status, error.response.statusText);
      logger.error('Response data:', error.response.data);
    }
    if (error.config) {
      logger.error('Request was sent to:', error.config.url);
    }
    throw new Error(`Failed to fetch game data for round ${round}, game ${game}. ${error.message}`);
  }
}

function generatePlayerToken(whiteName, blackName) {
  const combinedNames = `${whiteName}${blackName}`.replace(/\s+/g, '').toLowerCase();
  return combinedNames.slice(0, 8);
}

// Service 3: Get live updates for a game
function getLiveGameUpdates(round, game, callback) {
  const pollGameUpdates = async () => {
    let lastMoveCount = 0;
    
    while (true) {
      try {
        const [indexResponse, gameResponse] = await Promise.all([
          axios.get(getIndexUrl(round)),
          axios.get(getGameUrl(round, game))
        ]);

        const indexData = indexResponse.data;
        const gameData = gameResponse.data;

        const pairing = indexData.pairings[game - 1];
        if (!pairing) {
          throw new Error('Game not found in pairings');
        }

        const chess = new Chess();
        const cleanedPGN = cleanPGN(gameData.moves);
        chess.loadPgn(cleanedPGN);

        const lastMoveLAN = getLastMoveFromPGN(cleanedPGN);
        const fenBeforeLastMove = getFenBeforeLastMove(cleanedPGN);

        const currentGameState = {
          gameId: `${tournamentId}-${round}-${game}`,
          latestFEN: chess.fen(),
          fenBeforeLastMove,
          lastMove: lastMoveLAN,
          wName: `${pairing.white.fname} ${pairing.white.lname}`,
          bName: `${pairing.black.fname} ${pairing.black.lname}`,
          wFide: pairing.white.fideid,
          bFide: pairing.black.fideid,
          wTitle: pairing.white.title || '',
          bTitle: pairing.black.title || '',
          latestPGN: cleanedPGN,
          result: standardizeResult(gameData.result),
          isLive: gameData.live
        };

        if (!gameData.live) {
          callback({ type: 'gameEnd', ...currentGameState });
          break;
        }
        
        const currentMoveCount = cleanedPGN.split(' ').length;
        if (currentMoveCount > lastMoveCount) {
          const newMoves = cleanedPGN.split(' ').slice(lastMoveCount);
          lastMoveCount = currentMoveCount;
          callback({ type: 'newMoves', ...currentGameState, newMoves });
        }
        
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (error) {
        logger.error('Error polling game updates:', error);
        if (typeof callback === 'function') {
          callback({ type: 'error', error: 'An error occurred while polling game updates' });
        }
        // Wait for a short time before retrying
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  };

  pollGameUpdates();

  return () => {
    // Return a function to stop the polling if needed
    // This function can be called to clean up resources
  };
}

// Service 4: Get tournament details
async function getTournamentDetails() {
  try {
    const tourneyResponse = await axios.get(getTourneyUrl());
    const tourneyData = tourneyResponse.data;

    return {
      id: tourneyData.id,
      name: tourneyData.name,
      location: tourneyData.location,
      country: tourneyData.country,
      website: tourneyData.website,
      rules: tourneyData.rules,
      chess960: tourneyData.chess960,
      timeControl: tourneyData.timecontrol,
      totalRounds: tourneyData.rounds.length,
      completedRounds: tourneyData.rounds.filter(round => round.count > 0).length,
      eboards: tourneyData.eboards
    };
  } catch (error) {
    logger.error('Error:', error);
    throw new Error('An error occurred while fetching tournament details');
  }
}

// Service 5: Get players list for a specific round
async function getPlayersForRound(round) {
  try {
    const indexResponse = await axios.get(getIndexUrl(round));
    const indexData = indexResponse.data;

    const players = indexData.pairings.flatMap(pairing => [pairing.white, pairing.black]);
    const uniquePlayers = players.filter((player, index, self) =>
      index === self.findIndex((t) => t.fideid === player.fideid)
    );

    return {
      roundDate: indexData.date,
      players: uniquePlayers.map(player => ({
        name: `${player.fname} ${player.mname ? player.mname + ' ' : ''}${player.lname}`,
        title: player.title || '',
        federation: player.federation || '',
        gender: player.gender || '',
        fideId: player.fideid
      }))
    };
  } catch (error) {
    logger.error('Error:', error);
    throw new Error('An error occurred while fetching players list');
  }
}

// Service 6: Get round results
async function getRoundResults(round) {
  try {
    const indexResponse = await axios.get(getIndexUrl(round));
    const indexData = indexResponse.data;

    const results = indexData.pairings.map((pairing, index) => ({
      gameNumber: index + 1,
      white: `${pairing.white.fname} ${pairing.white.lname}`,
      black: `${pairing.black.fname} ${pairing.black.lname}`,
      result: standardizeResult(pairing.result),
      isLive: pairing.live
    }));

    return {
      roundDate: indexData.date,
      results: results
    };
  } catch (error) {
    logger.error('Error:', error);
    throw new Error('An error occurred while fetching round results');
  }
}

// Service 7: Get player's games in a tournament
async function getPlayerGames(fideId) {
  try {
    const tourneyResponse = await axios.get(getTourneyUrl());
    const tourneyData = tourneyResponse.data;

    const playerGames = [];

    for (let roundNum = 1; roundNum <= tourneyData.rounds.length; roundNum++) {
      if (tourneyData.rounds[roundNum - 1].count > 0) {
        const indexResponse = await axios.get(getIndexUrl(roundNum));
        const indexData = indexResponse.data;

        const game = indexData.pairings.find(pairing => 
          pairing.white.fideid === fideId || pairing.black.fideid === fideId
        );

        if (game) {
          playerGames.push({
            round: roundNum,
            date: indexData.date,
            color: game.white.fideid === fideId ? 'white' : 'black',
            opponent: game.white.fideid === fideId 
              ? `${game.black.fname} ${game.black.lname}`
              : `${game.white.fname} ${game.white.lname}`,
            result: standardizeResult(game.result),
            isLive: game.live
          });
        }
      }
    }

    return {
      fideId: fideId,
      games: playerGames
    };
  } catch (error) {
    logger.error('Error:', error);
    throw new Error('An error occurred while fetching player\'s games');
  }
}

// Service 8: Get all games from the latest round
async function getLatestRoundGames() {
  try {
    const latestRound = await getLatestRoundNumber();
    
    if (latestRound === 0) {
      logger.info('No rounds with games found');
      return { games: [] };
    }

    const indexResponse = await axios.get(getIndexUrl(latestRound));
    const indexData = indexResponse.data;

    const games = await Promise.all(indexData.pairings.map(async (pairing, index) => {
      if (!pairing) {
        logger.warn(`Pairing ${index + 1} is null or undefined`);
        return null;
      }

      try {
        const gameResponse = await axios.get(getGameUrl(latestRound, index + 1));
        const gameData = gameResponse.data;

        const chess = new Chess();
        const cleanedPGN = cleanPGN(gameData.moves);
        
        try {
          chess.loadPgn(cleanedPGN);
        } catch (chessError) {
          logger.warn(`Error loading PGN for game ${index + 1}: ${chessError.message}`);
          return {
            gameNumber: index + 1,
            round: latestRound,
            white: {
              name: `${pairing.white?.fname || 'Unknown'} ${pairing.white?.lname || ''}`,
              title: pairing.white?.title || '',
              fideId: pairing.white?.fideid || ''
            },
            black: {
              name: `${pairing.black?.fname || 'Unknown'} ${pairing.black?.lname || ''}`,
              title: pairing.black?.title || '',
              fideId: pairing.black?.fideid || ''
            },
            result: standardizeResult(gameData.result),
            isLive: gameData.live,
            error: 'Unable to load PGN'
          };
        }

        return {
          gameNumber: index + 1,
          round: latestRound,
          white: {
            name: `${pairing.white?.fname || 'Unknown'} ${pairing.white?.lname || ''}`,
            title: pairing.white?.title || '',
            fideId: pairing.white?.fideid || ''
          },
          black: {
            name: `${pairing.black?.fname || 'Unknown'} ${pairing.black?.lname || ''}`,
            title: pairing.black?.title || '',
            fideId: pairing.black?.fideid || ''
          },
          result: standardizeResult(gameData.result),
          isLive: gameData.live,
          latestFEN: chess.fen(),
          latestPGN: cleanedPGN
        };
      } catch (error) {
        logger.warn(`Error fetching game ${index + 1}: ${error.message}`);
        return null;
      }
    }));

    return {
      tournamentId: tournamentId,
      roundNumber: latestRound,
      roundDate: indexData.date,
      games: games.filter(game => game !== null)
    };
  } catch (error) {
    logger.error('Error fetching latest round games:', error);
    return { games: [] };
  }
}

const COMMENTARY_API_URL = process.env.COMMENTARY_API_URL;

async function fetchCommentary(latestFEN, lastMove, whiteName, blackName) {
  if (latestFEN === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
    logger.info('Initial position, skipping commentary fetch');
    return null;
  }

  try {
    const payload = {
      fen: latestFEN,
      last_move: lastMove,
      white_name: whiteName,
      black_name: blackName
    };

    logger.info(`Sending request to commentary API: ${COMMENTARY_API_URL}`, payload);

    const response = await axios.post(COMMENTARY_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    logger.info('Received response from commentary API', {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: JSON.stringify(response.data).slice(0, 500) // Log first 500 characters of stringified data
    });

    if (response.data.error) {
      logger.warn('API returned an error:', response.data.error);
      return null;
    }

    // Updated check for commentary and stockfish_eval
    if (!response.data.commentary || typeof response.data.stockfish_eval !== 'number') {
      logger.warn('API response is missing commentary or stockfish_eval', response.data);
      return null;
    }

    return {
      commentary: response.data.commentary,
      stockfishEval: response.data.stockfish_eval
    };
  } catch (error) {
    logger.error('Error fetching commentary:', {
      message: error.message,
      stack: error.stack,
      config: error.config,
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers,
        data: JSON.stringify(error.response.data).slice(0, 500)
      } : 'No response'
    });
    return null;
  }
}

async function generateAndUploadImage(fen, wName, bName, evaluation, highlightSquares) {
  try {
    // Generate image
    const response = await axios.post(process.env.IMAGE_GENERATION_API_URL, {
      fen,
      wName,
      bName,
      evaluation,
      highlightSquares
    }, {
      responseType: 'arraybuffer'
    });

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
        'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
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

module.exports = {
  getAvailableRoundsAndGames,
  getGameState,
  getLiveGameUpdates,
  getTournamentDetails,
  getPlayersForRound,
  getRoundResults,
  getPlayerGames,
  getLatestRoundGames,
  fetchCommentary,
  generateAndUploadImage
};