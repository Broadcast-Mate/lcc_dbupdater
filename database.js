// database.js

const { MongoClient } = require('mongodb');
const logger = require('./logger');

let dbInstance = null;

async function connectToDatabase() {
  if (dbInstance) {
    return dbInstance;
  }

  try {
    const client = await MongoClient.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    dbInstance = client.db(process.env.DB_NAME);
    logger.info('Connected to MongoDB');
    return dbInstance;
  } catch (error) {
    logger.error('Error connecting to MongoDB:', error);
    throw error;
  }
}

module.exports = {
  connectToDatabase,
};
