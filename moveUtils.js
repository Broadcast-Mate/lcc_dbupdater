const { Chess } = require('chess.js');

function getLastMoveFromPGN(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });
  if (history.length === 0) return 'initial';
  const lastMove = history[history.length - 1];
  return `${lastMove.from}${lastMove.to}${lastMove.promotion || ''}`;
}

function getFenBeforeLastMove(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  chess.undo();
  return chess.fen();
}

module.exports = {
  getLastMoveFromPGN,
  getFenBeforeLastMove
};