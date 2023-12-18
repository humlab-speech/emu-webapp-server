const axios = require('axios');
const { MongoClient } = require('mongodb');
require('dotenv').config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// GitLab API endpoint and personal access token
const gitlabUrl = 'https://gitlab.visp.local/api/v4'; // Replace with your GitLab URL
const accessToken = process.env.GITLAB_PAT; // Replace with your GitLab access token

// MongoDB connection details
const mongoUrl = 'mongodb://localhost:27017'; // Replace with your MongoDB URL
const dbName = 'visp'; // Replace with your MongoDB database name
const collectionName = 'users'; // Replace with the desired collection name

async function connectToMongo() {
  const mongodbUrl = 'mongodb://root:' + process.env.MONGO_ROOT_PASSWORD + '@localhost:27017';
  let mongoClient = new MongoClient(mongodbUrl);
  await mongoClient.connect();
  let db = mongoClient.db(process.env.MONGO_DB_NAME);
  return db;
}

// Fetch and export users
async function fetchAndExportUsers() {
  try {
    // Fetch all users from GitLab API
    const response = await axios.get(`${gitlabUrl}/users`, {
      headers: {
        'PRIVATE-TOKEN': accessToken,
      },
    });

    // Store users in MongoDB
    await storeUsers(response.data);

    console.log('Users exported successfully.');
  } catch (error) {
    console.error('An error occurred:', error.message);
  }
}

// Store users in MongoDB
async function storeUsers(users) {
  let db = await connectToMongo();

  try {
    const collection = db.collection(collectionName);
    await collection.insertMany(users);
  } catch (error) {
    console.error('Failed to insert users');
    console.error(error);
  }
}

// Start the script
fetchAndExportUsers();
