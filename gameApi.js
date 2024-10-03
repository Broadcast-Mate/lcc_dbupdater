const express = require('express');
const router = express.Router();
const { getDatabase } = require('./database');
const ObjectId = require('mongodb').ObjectId;

// Get all ongoing games for a tournament
router.get('/tournament/:tournamentId/games', async (req, res) => {
    try {
        const db = await getDatabase();
        const tournamentId = req.params.tournamentId;
        const collection = db.collection(process.env.COLLECTION_NAME);

        const games = await collection.find({
            tournamentId: tournamentId,
            status: 'ongoing'
        }).toArray();

        res.json(games);
    } catch (error) {
        console.error('Error fetching ongoing games:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get details for a specific game
router.get('/game/:gameId', async (req, res) => {
    try {
        const db = await getDatabase();
        const gameId = req.params.gameId;
        const collection = db.collection(process.env.COLLECTION_NAME);

        const game = await collection.findOne({ _id: new ObjectId(gameId) });

        if (!game) {
            return res.status(404).json({ error: 'Game not found' });
        }

        res.json({
            gameId: game._id,
            tournamentId: game.tournamentId,
            round: game.round,
            whitePlayer: game.whitePlayer,
            blackPlayer: game.blackPlayer,
            status: game.status,
            result: game.result,
            pgn: game.pgn,
            commentary: game.commentary,
            stockfishEval: game.stockfishEval,
            mediaId: game.mediaId
        });
    } catch (error) {
        console.error('Error fetching game details:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get tournament results
router.get('/tournament/:tournamentId/results', async (req, res) => {
    try {
        const db = await getDatabase();
        const tournamentId = req.params.tournamentId;
        const collection = db.collection(process.env.COLLECTION_NAME);

        const results = await collection.find({
            tournamentId: tournamentId,
            status: 'completed'
        }).toArray();

        res.json(results);
    } catch (error) {
        console.error('Error fetching tournament results:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;