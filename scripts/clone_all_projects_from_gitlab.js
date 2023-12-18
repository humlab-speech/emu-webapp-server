/*
const axios = require('axios');
const { exec } = require('child_process');
const { MongoClient } = require('mongodb');
const { resolve } = require('path');
require('dotenv').config();
*/
import axios from 'axios';
import { exec } from 'child_process';
import { MongoClient } from 'mongodb';
import { resolve } from 'path';
import dotenv from "dotenv";

dotenv.config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// GitLab API endpoint and personal access token
const gitlabUrl = 'https://gitlab.visp.local/api/v4'; // Replace with your GitLab URL
const accessToken = process.env.GITLAB_PAT; // Replace with your GitLab access token

// MongoDB connection details
const mongoUrl = 'mongodb://localhost:27017'; // Replace with your MongoDB URL
const dbName = 'visp'; // Replace with your MongoDB database name
const collectionName = 'projects'; // Replace with the desired collection name

async function connectToMongo() {
    const mongodbUrl = 'mongodb://root:'+process.env.MONGO_ROOT_PASSWORD+'@localhost:27017';
    let mongoClient = new MongoClient(mongodbUrl);
    await mongoClient.connect();
    let db = mongoClient.db(process.env.MONGO_DB_NAME);
    return db;
}

// Fetch and clone projects
async function fetchAndCloneProjects() {
  try {
    // Fetch all projects from GitLab API
    const response = await axios.get(`${gitlabUrl}/projects`, {
      headers: {
        'PRIVATE-TOKEN': accessToken
      }
    });
    console.log(response.data)
    // Group projects by username
    const projectsByUser = {};
    response.data.forEach((project) => {
      const { id, owner, name, http_url_to_repo, path } = project;
      if(owner) {
        if (!projectsByUser[owner.username]) {
            projectsByUser[owner.username] = [];
        }
        projectsByUser[owner.username].push({ id, name, http_url_to_repo, path, owner });
      }
    });
    // Clone projects and store metadata in MongoDB
    await Promise.all(
      Object.entries(projectsByUser).map(async ([username, projects]) => {
        console.log("username:"+username)
        const dir = `./cloned-repositories/${username}`;
        await execCommand(`mkdir -p ${dir}`);

        await Promise.all(
          projects.map(async (project) => {
            const { name, http_url_to_repo, path } = project;
            const projectDir = `${dir}/${path}`;
            const gitUrlWithToken = `${http_url_to_repo.replace('https://', `https://oauth2:${accessToken}@`)}`;
            await execCommand(`git -c http.sslVerify=false clone ${gitUrlWithToken} ${projectDir}`);

            const projectMembers = await getProjectMembers(project.id);

            await storeProjectMetadata({
                id: project.id,
                name: project.name,
                path: project.path,
                owner: project.owner ? project.owner.id : null,
                members: projectMembers,
            });
          })
        );
      })
    );

    console.log('Projects cloned and metadata stored successfully.');
  } catch (error) {
    console.error('An error occurred:', error.message);
  }
}

// Execute shell command
function execCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}




// Store project metadata in MongoDB
async function storeProjectMetadata(projectMetadata) {
  let db = await connectToMongo();

  try {
    const collection = db.collection(collectionName);
    await collection.insertOne(projectMetadata);
  } catch (error) {
    console.error('Failed to insert project metadata');
    console.error(error);
  }
}

// Get project members from GitLab API
async function getProjectMembers(projectId) {
    try {
        const response = await axios.get(`${gitlabUrl}/projects/${projectId}/members`, {
        headers: {
            'PRIVATE-TOKEN': accessToken
        }
        });

        let members = [];
        response.data.forEach(member => {
            members.push(member.id);
        });

        return members;
    } catch (error) {
        console.error(`Failed to retrieve project members for project ID: ${projectId}`);
        console.error(error);
        return [];
    }
}

// Start the script
fetchAndCloneProjects();
