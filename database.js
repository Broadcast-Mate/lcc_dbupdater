const { MongoClient } = require('mongodb');
const logger = require('./logger');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME;

let client = null;
let db = null;

async function connectToDatabase() {
  if (db) return db;

  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    logger.info('Connected to MongoDB');
    return db;
  } catch (error) {
    logger.error('Error connecting to MongoDB:', error);
    throw error;
  }
}

async function getDatabase() {
  if (!db) {
    await connectToDatabase();
  }
  return db;
}

// Optional: Add a function to close the connection if needed
async function closeDatabaseConnection() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    logger.info('Closed MongoDB connection');
  }
}

module.exports = {
  connectToDatabase,
  getDatabase
};