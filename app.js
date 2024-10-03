require('dotenv').config();
const express = require('express');
const { startDatabaseUpdater } = require('./updateDatabase');
const { connectToDatabase } = require('./database');
const gameApiRouter = require('./gameApi'); // Add this line

const app = express();
const port = process.env.PORT || 3000;

async function startServices() {
  console.log('Starting services...');

  try {
    // Connect to the database
    console.log('Connecting to database...');
    await connectToDatabase();
    console.log('Connected to database successfully');

    // Start the database updater
    console.log('Starting database updater...');
    startDatabaseUpdater();
    console.log('Database updater started successfully');

    // Use the gameApi router
    app.use('/api', gameApiRouter); // Add this line

    // Start the Express server
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
      console.log('All services started successfully');
    });
  } catch (error) {
    console.error('Error starting services:', error);
    // Instead of exiting, we'll retry the connection after a delay
    console.log('Retrying in 30 seconds...');
    setTimeout(startServices, 30000);
  }
}

startServices();