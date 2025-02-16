import express from 'express';
import cookieParser from 'cookie-parser';
import cookie from 'cookie';
import WebSocket, { WebSocketServer } from 'ws';
import { MongoClient } from 'mongodb';
import http from 'http';
import fs from 'fs';
import mime from 'mime-types';
import simpleGit from 'simple-git';
import colors from 'colors';
import { parseFile } from "music-metadata"
import dotenv from "dotenv";
import { exit } from 'process';

import VispAuth from './authModules/visp.module.js';

class EmuWebappServer {
  constructor() {
    this.name = "EMU-webapp-server";
    this.version = "1.0.8";
    dotenv.config();
    colors.enable();
    this.logLevel = process.env.LOG_LEVEL ? process.env.LOG_LEVEL.toUpperCase() : "INFO";
    this.addLog("Log level is "+this.logLevel, "INFO");
    this.app = express();
    this.app.use(cookieParser());
    this.server = null;
    this.db = null;

    const expectedEnvVars = ["MONGO_DB_NAME", "MONGO_URI", "REPOSITORIES_PATH", "MEDIA_FILE_BASE_URL"];
    expectedEnvVars.forEach((envVar) => {
      if(typeof process.env[envVar] == "undefined") {
        this.addLog(envVar+" environment variable not set", "error");
        process.exit(1);
      }
    });

    this.authModule = new VispAuth(this);

    this.connectToMongo(process.env.MONGO_DB_NAME);
    this.setupEndpoints();
    this.startServer();
    this.setupWebSocket();
  }

  setupEndpoints() {
    //These are the regular http endpoints, not the websockets part
    this.app.get('*', (req, res, next) => {
      this.addLog(req.method+" "+req.path);
      next();
    });
    this.app.get('/', (req, res) => {
      res.send('You have requested an empty endpoint.');
    });

    this.app.get('/file/project/:projectId/session/:sessionName/file/:fileName', async (req, res) => {
      let sessionName = req.params.sessionName;
      let fileName = req.params.fileName;
      let bundleName = fileName.split(".")[0];
      let authResult = await this.authModule.authenticateUser(req.cookies.PHPSESSID, req.params.projectId);

      if(authResult.authenticated == false) {
        this.addLog("User not authenticated while trying to access file "+fileName+" in session "+sessionName+" in project "+projectId+". Reason was: "+authResult.reason, "warn");
        res.status(401);
        res.send('You are not authenticated.');
        return;
      }

      let user = authResult.user;

      //get project from mongodb
      let project = await this.db.collection('projects').findOne({id: req.params.projectId});

      const path = process.env.REPOSITORIES_PATH+"/"+req.params.projectId+"/Data/VISP_emuDB/"+sessionName+"_ses/"+bundleName+"_bndl/"+fileName;
      this.addLog("Requested file: "+path, "debug");

      //check that the file exists
      if(!fs.existsSync(path)) {
        this.addLog("File not found: "+path, "warn");
        res.status(404);
        res.send('File not found.');
        return;
      }

      //read mimetype from file
      const mimeType = mime.lookup(path);
      let fileData = fs.readFileSync(path);
      res.setHeader('Content-Type', mimeType);
      res.end(fileData);
    });
  }

  startServer() {
    const port = process.env.WS_SERVER_PORT || 17890;
    this.server = this.app.listen(port, () => {
      this.addLog(this.name+' '+this.version+' is running on port '+port);
    });
  }

  setupWebSocket() {
    const wss = new WebSocketServer({ server: this.server });

    wss.on('connection', async (ws, req) => {
      this.addLog('Client connected');
      const parsedCookies = cookie.parse(req.headers.cookie);
      ws.PHPSESSID = parsedCookies.PHPSESSID;
      ws.projectId = parsedCookies.projectId;

      this.addLog("PHPSESSID: "+ws.PHPSESSID+", projectId: "+ws.projectId, "debug");
      
      ws.on('message', async (message) => {
        try {
          //this.addLog('Received message: '+message, "debug");
          const request = JSON.parse(message);
          let authResult = await this.authModule.authenticateUser(ws.PHPSESSID, ws.projectId);
          if(!authResult.authenticated) {
            //send error message
            const authErrorResponse = {
              callbackID: request.callbackID,
              status: {
                type: 'ERROR',
                message: authResult.reason,
              },
            };
            this.addLog("User failed authentication/authorization. Reason: "+authResult.reason, "warn");
            ws.send(JSON.stringify(authErrorResponse));
            return;
          }
  
          let user = authResult.user;
          this.addLog(request.type+" from user "+user.username);
  
          switch (request.type) {
            case 'GETPROTOCOL':
              this.getProtocol(ws, request);
              break;
            case 'GETDOUSERMANAGEMENT':
              this.doUserManagement(ws, request);
              break;
            case 'LOGONUSER':
              console.warn("Request type was LOGONUSER, but it is not supported");
              break;
            case 'GETGLOBALDBCONFIG':
              this.getDbConfig(ws, request, user, parsedCookies.projectId);
              break;
            case 'GETBUNDLELIST':
              this.getBundleList(ws, request, user, parsedCookies.projectId);
              break;
            case 'GETBUNDLE':
              this.getBundle(ws, request, user, parsedCookies.projectId);
              break;
            case 'SAVEBUNDLE':
              this.saveBundle(ws, request, user, parsedCookies.projectId);
              break;
            default:
              // Handle unknown request
              const unknownResponse = {
                callbackID: request.callbackID,
                status: {
                  type: 'ERROR',
                  message: 'Unknown command',
                },
              };
              ws.send(JSON.stringify(unknownResponse));
              break;
          }
        } catch (error) {
          // Handle JSON parsing or other errors
          this.addLog(error, "error");
        }
      });
  
      ws.on('close', () => {
        this.addLog('Client disconnected');
      });
    });
  }

  bindWebSocketEventHandlers(ws) {
    
  }

  getProtocol(ws, request) {
    const { type, callbackID } = request;
    const response = {
      callbackID,
      data: {
        protocol: 'EMU-webApp-websocket-protocol',
        version: '0.0.2',
      },
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(response));
  }

  doUserManagement(ws, request) {
    const { type, callbackID } = request;
    const userManagementResponse = {
      callbackID,
      data: 'NO',
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(userManagementResponse));
  }
  
  async getDbConfig(ws, request, user, projectId) {
    const { type, callbackID } = request;

    //get project from mongodb
    let project = await this.db.collection('projects').findOne({id: projectId});

    //use fs to read the file
    const filePath = process.env.REPOSITORIES_PATH+"/"+projectId+"/Data/VISP_emuDB/VISP_DBconfig.json"
    let configData = fs.readFileSync(filePath, 'utf8');

    // Send GETGLOBALDBCONFIG response
    const globalDBConfigResponse = {
      callbackID,
      data: JSON.parse(configData), 
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(globalDBConfigResponse));
  }

  async getBundleList(ws, request, user, projectId) {
    const { type, callbackID } = request;

    let bundleList = await this.db.collection("bundlelists").findOne({projectId: projectId, owner: user.username});

    let data = [];
    if(bundleList) {
      data = bundleList.bundles;
    }
    if(data.length == 0) {
      //a valid bundlelist (according to emu-webapp) must contain a least one bundle, so this will result in a client side error
      this.addLog("Bundlelist is empty / not found", "warning");
    }

    // Send GETBUNDLELIST response
    const bundleListResponse = {
      callbackID,
      data: data,
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(bundleListResponse));
  }

  async saveBundleList(ws, request, user, projectId) {
    const { type, callbackID } = request;

    let bundleList = await this.db.collection("bundlelists").findOne({projectId: projectId, owner: user.username});

    if(bundleList) {
      await this.db.collection("bundlelists").updateOne(
        {projectId: projectId, owner: user.username},
        {$set: {bundles: request.data}}
      );
    } else {
      await this.db.collection("bundlelists").insertOne({
        projectId: projectId,
        owner: user.username,
        bundles: request.data
      });
    }

    // Send SAVEBUNDLELIST response
    const saveBundleListResponse = {
      callbackID,
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(saveBundleListResponse));
  }

  async getBundle(ws, request, user, projectId) {
    const { name, session, callbackID } = request;

    let bundleBasename = name;
    let audioFileExtension = "wav";
    let filename = bundleBasename+"."+audioFileExtension;

    let mediaUrl = process.env.MEDIA_FILE_BASE_URL+"/file/project/"+projectId+"/session/"+session+"/file/"+bundleBasename+"."+audioFileExtension;

    //get project from mongodb
    let project = await this.db.collection('projects').findOne({id: projectId});
    
     //check that the user has access to this project
    if(!project.members.find(member => member.username == user.username)) {
      this.addLog("User "+user.username+" does not have access to project "+projectId+".", "error");
      const bundleResponse = {
        callbackID,
        status: {
          type: 'ERROR',
          message: 'User does not have access to project.',
        },
      };
      ws.send(JSON.stringify(bundleResponse));
      return;
    }
   

    let bundlePath = process.env.REPOSITORIES_PATH+"/"+projectId+"/Data/VISP_emuDB/"+session+"_ses/"+bundleBasename+"_bndl";
    
    //read dbconfig file - this should always exist
    let dbConfigPath = process.env.REPOSITORIES_PATH+"/"+projectId+"/Data/VISP_emuDB/VISP_DBconfig.json";
    let configData = null;
    try {
      configData = fs.readFileSync(dbConfigPath, 'utf8');
    }
    catch(error) {
      this.addLog("Error reading DBconfig file: "+error, "error");
      const bundleResponse = {
        callbackID,
        status: {
          type: 'ERROR',
          message: 'Error reading DBconfig file. '+error,
        },
      };
      ws.send(JSON.stringify(bundleResponse));
      return;
    }
    
    let emuDbConfig = JSON.parse(configData);
    let trackFiles = [];
    emuDbConfig.ssffTrackDefinitions.forEach(trackDef => {

      this.addLog("Attempting to read "+trackDef.name+" track file: "+bundlePath+"/"+bundleBasename+"."+trackDef.fileExtension, "debug");

      if(fs.existsSync(bundlePath+"/"+bundleBasename+"."+trackDef.fileExtension)) {
        this.addLog("Found "+trackDef.name+" track file: "+bundlePath+"/"+bundleBasename+"."+trackDef.fileExtension, "debug");
        let trackData = fs.readFileSync(bundlePath+"/"+bundleBasename+"."+trackDef.fileExtension);
        let trackDataBase64 = trackData.toString('base64');
        let trackFile = {
          data: trackDataBase64,
          encoding: "BASE64",
          fileExtension: trackDef.fileExtension,
        };
        trackFiles.push(trackFile);
      }
      else {
        this.addLog("Track file not found: "+bundlePath+"/"+bundleBasename+"."+trackDef.fileExtension, "warn");
      }
    });
    
    let audioFileMetadata = null;
    try {
      audioFileMetadata = await parseFile(bundlePath + "/" + bundleBasename + "." + audioFileExtension);
    } catch (error) {
      this.addLog("Error reading files: "+error, "error");
      const bundleResponse = {
        callbackID,
        status: {
          type: 'ERROR',
          message: 'Error reading files. '+error,
        },
      };
      ws.send(JSON.stringify(bundleResponse));
    }


    //load the <bundlename>_annot.json data
    let annotationData = null;
    try {
      annotationData = this.getBundleAnnotationData(bundlePath, bundleBasename);
    }
    catch(error) {
      this.addLog("Error reading annotation file: "+error, "error");
      const bundleResponse = {
        callbackID,
        status: {
          type: 'ERROR',
          message: 'Error reading annotation file. '+error,
        },
      };
      ws.send(JSON.stringify(bundleResponse));
      return;
    }

    let bundleData = {
      annotation: annotationData,
      mediaFile: {
        data: mediaUrl,
        encoding: "GETURL"
      },
      ssffFiles: trackFiles,
    };
 
    // Send GETBUNDLE response
    const bundleResponse = {
      callbackID,
      data: bundleData,
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(bundleResponse));
  }


  getBundleAnnotationData(bundlePath, bundleName) {
    let annotationDataString = fs.readFileSync(bundlePath+"/"+bundleName+"_annot.json", 'utf8');
    let annotationData = JSON.parse(annotationDataString);
    return annotationData;
  }

  saveBundleAnnotationData(bundlePath, bundleName, annotationData) {
    fs.writeFileSync(bundlePath+"/"+bundleName+"_annot.json", JSON.stringify(annotationData, null, 2));
  }

  getUser(req, cookies) {
    return this.authModule.getUser(cookies.PHPSESSID);
  }

  async fetchProjectOLD(req, cookies) {
    return await this.db.collection('projects').findOne({id: parseInt(cookies.projectId)});
  }

  async fetchProject(projectId) {
    return await this.db.collection('projects').findOne({id: projectId});
  }

  getSession(req) {
    return req.session;
  }

  async saveBundle(ws, request, user, projectId) {
    let reqData = request.data;
    let bundleName = reqData.annotation.name;

    let bundlePath = process.env.REPOSITORIES_PATH+"/"+projectId+"/Data/VISP_emuDB/"+reqData.session+"_ses/"+bundleName+"_bndl";

    for(let key in reqData.ssffFiles) {
      let ssffFile = reqData.ssffFiles[key];
      let decodedData = Buffer.from(ssffFile.data, ssffFile.encoding.toLowerCase());
      fs.writeFileSync(bundlePath+"/"+bundleName+"."+ssffFile.fileExtension, decodedData);
      //await git.add(bundlePath+"/"+bundleName+"."+ssffFile.fileExtension);
    }

    this.saveBundleAnnotationData(bundlePath, bundleName, reqData.annotation);
    
    let bundleList = await this.db.collection("bundlelists").findOne({projectId: projectId, owner: user.username});
    if(bundleList) {
      bundleList.bundles.forEach((bundleListItem) => {
        if(bundleListItem.name == bundleName && bundleListItem.session == reqData.session) {
          bundleListItem.finishedEditing = reqData.finishedEditing ? true : false; //make sure it's a boolean
          bundleListItem.comment = reqData.comment;
        }
      });

      this.db.collection("bundlelists").updateOne(
        {projectId: projectId, owner: user.username},
        {$set: {bundles: bundleList.bundles}}
      );
    }
    else {
      this.addLog("Bundlelist not found when saving bundle", "error");
    }

    // Send SAVEBUNDLE response
    const { type, callbackID } = request;
    const saveBundleResponse = {
      callbackID,
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(saveBundleResponse));
  }

  connectToMongo(dbName) {
    MongoClient.connect(process.env.MONGO_URI, { useUnifiedTopology: true })
      .then(client => {
        this.addLog('Connected to MongoDB');

        // Select the database
        this.db = client.db(dbName);
      })
      .catch(err => {
        this.addLog('Failed to connect to MongoDB', "error");
      });
  }

  disconnectFromMongo() {
    this.mongoClient.close();
  }

  addLog(msg, level = 'info') {
    let levelMsg = new String(level).toUpperCase();
    if(levelMsg == "DEBUG" && this.logLevel == "INFO") {
      return;
    }

    let levelMsgColor = levelMsg;

    if(levelMsg == "WARNING") { levelMsg = "WARN"; }

    switch(levelMsg) {
      case "INFO":
        levelMsgColor = colors.green(levelMsg);
      break;
      case "WARN":
        levelMsgColor = colors.yellow(levelMsg);
      break;
      case "ERROR":
        levelMsgColor = colors.red(levelMsg);
      break;
      case "DEBUG":
        levelMsgColor = colors.cyan(levelMsg);
      break;
    }
    
    let logMsg = new Date().toLocaleDateString("sv-SE")+" "+new Date().toLocaleTimeString("sv-SE");
    let printMsg = logMsg+" ["+levelMsgColor+"] "+msg;
    let writeMsg = logMsg+" ["+levelMsg+"] "+msg+"\n";

    let logFile = "logs/emu-webapp-server.log";
    switch(level) {
      case 'info':
        console.log(printMsg);
        fs.appendFileSync(logFile, writeMsg);
        break;
      case 'warn':
        console.warn(printMsg);
        fs.appendFileSync(logFile, writeMsg);
        break;
      case 'error':
        console.error(printMsg);
        fs.appendFileSync(logFile, writeMsg);
        break;
      default:
        console.error(printMsg);
        fs.appendFileSync(logFile, writeMsg);
    }
  }

}

new EmuWebappServer();
