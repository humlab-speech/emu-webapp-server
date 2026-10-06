import express from 'express';
import cookie from 'cookie';
import { WebSocketServer } from 'ws';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import colors from 'colors';
import dotenv from "dotenv";

import VispAuth from './authModules/visp.module.js';
import { safePathComponent, safeJoinedPath } from './pathSecurity.js';

//the only media file type getBundle() hands out URLs for
const AUDIO_FILE_EXTENSION = "wav";

class EmuWebappServer {
  constructor() {
    this.name = "EMU-webapp-server";
    this.version = "1.1.0";
    dotenv.config();
    colors.enable();
    this.logLevel = process.env.LOG_LEVEL ? process.env.LOG_LEVEL.toUpperCase() : "INFO";
    this.addLog("Log level is "+this.logLevel, "INFO");
    this.app = express();
    this.app.disable('x-powered-by');
    this.server = null;
    this.db = null;

    const expectedEnvVars = ["MONGO_DB_NAME", "MONGO_URI", "REPOSITORIES_PATH", "MEDIA_FILE_BASE_URL"];
    expectedEnvVars.forEach((envVar) => {
      if(typeof process.env[envVar] == "undefined") {
        this.addLog(envVar+" environment variable not set", "error");
        process.exit(1);
      }
    });

    //browsers send the Origin of the page opening a websocket, but do not enforce any policy on it - we have to,
    //or any site the user visits could talk to us with their cookies (cross-site websocket hijacking)
    this.allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",").map(origin => origin.trim()).filter(origin => origin)
      : [new URL(process.env.MEDIA_FILE_BASE_URL).origin];
    this.addLog("Allowed websocket origins: "+this.allowedOrigins.join(", "));

    this.authModule = new VispAuth(this);

    this.connectToMongo(process.env.MONGO_DB_NAME);
    this.setupEndpoints();
    this.startServer();
    this.setupWebSocket();
  }

  //cookie.parse only ever yields plain string values
  parseCookies(cookieHeader) {
    if(typeof cookieHeader !== 'string' || cookieHeader.length == 0) {
      return {};
    }
    return cookie.parse(cookieHeader);
  }

  emuDbPath(projectId) {
    return safeJoinedPath(process.env.REPOSITORIES_PATH, safePathComponent(projectId, "projectId"), "Data", "VISP_emuDB");
  }

  bundlePath(projectId, sessionName, bundleName) {
    return safeJoinedPath(
      this.emuDbPath(projectId),
      safePathComponent(sessionName, "session")+"_ses",
      safePathComponent(bundleName, "bundle")+"_bndl"
    );
  }

  readDbConfig(projectId) {
    return JSON.parse(fs.readFileSync(safeJoinedPath(this.emuDbPath(projectId), "VISP_DBconfig.json"), 'utf8'));
  }

  sendError(ws, callbackID, message) {
    ws.send(JSON.stringify({
      callbackID,
      status: {
        type: 'ERROR',
        message: message,
      },
    }));
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
      const { projectId, sessionName, fileName } = req.params;
      try {
        let authResult = await this.authModule.authenticateUser(this.parseCookies(req.headers.cookie).PHPSESSID, projectId);

        if(authResult.authenticated == false) {
          this.addLog("User not authenticated while trying to access file "+fileName+" in session "+sessionName+" in project "+projectId+". Reason was: "+authResult.reason, "warn");
          res.status(401);
          res.send('You are not authenticated.');
          return;
        }

        //only the bundle audio files that getBundle() links to are served from here
        const extensionSuffix = "."+AUDIO_FILE_EXTENSION;
        if(!fileName.endsWith(extensionSuffix)) {
          res.status(404);
          res.send('File not found.');
          return;
        }
        const bundleName = fileName.slice(0, -extensionSuffix.length);
        const path = safeJoinedPath(this.bundlePath(projectId, sessionName, bundleName), bundleName+extensionSuffix);
        this.addLog("Requested file: "+path, "debug");

        if(!fs.existsSync(path)) {
          this.addLog("File not found: "+path, "warn");
          res.status(404);
          res.send('File not found.');
          return;
        }

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(path, (error) => {
          if(error && !res.headersSent) {
            this.addLog("Error sending file "+path+": "+error.message, "error");
            res.status(500).end();
          }
        });
      }
      catch(error) {
        this.addLog("Error serving file "+fileName+" in session "+sessionName+" in project "+projectId+": "+error.message, "warn");
        if(!res.headersSent) {
          res.status(400);
          res.send('Bad request.');
        }
      }
    });
  }

  startServer() {
    const port = process.env.WS_SERVER_PORT || 17890;
    this.server = this.app.listen(port, () => {
      this.addLog(this.name+' '+this.version+' is running on port '+port);
    });
  }

  setupWebSocket() {
    const wss = new WebSocketServer({
      server: this.server,
      verifyClient: (info, callback) => {
        if(this.allowedOrigins.includes(info.origin)) {
          callback(true);
          return;
        }
        this.addLog("Rejected websocket connection from origin "+info.origin, "warn");
        callback(false, 403, "Origin not allowed");
      },
    });

    wss.on('connection', async (ws, req) => {
      this.addLog('Client connected');

      let parsedCookies = {};
      try {
        parsedCookies = this.parseCookies(req?.headers?.cookie);
      } catch (err) {
        this.addLog('Error parsing WebSocket cookies: '+err?.message, 'error');
        ws.close(1008, 'Invalid cookies');
        return;
      }

      ws.PHPSESSID = parsedCookies.PHPSESSID;
      ws.projectId = parsedCookies.projectId;

      this.addLog("projectId: "+ws.projectId, "debug");

      if (!ws.projectId) {
        this.addLog('Closing WebSocket: missing projectId', 'warn');
        ws.close(1008, 'No project id provided');
        return;
      }

      if (!ws.PHPSESSID) {
        this.addLog('Closing WebSocket: missing PHPSESSID', 'warn');
        ws.close(1008, 'No PHP session id provided');
        return;
      }

      ws.on('message', async (message) => {
        let request = null;
        try {
          request = JSON.parse(message);
          //re-checked for every message, so logging out or losing project membership takes effect immediately
          let authResult = await this.authModule.authenticateUser(ws.PHPSESSID, ws.projectId);
          if(!authResult.authenticated) {
            this.addLog("User failed authentication/authorization. Reason: "+authResult.reason, "warn");
            this.sendError(ws, request.callbackID, authResult.reason);
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
              await this.getDbConfig(ws, request, user, ws.projectId);
              break;
            case 'GETBUNDLELIST':
              await this.getBundleList(ws, request, user, ws.projectId);
              break;
            case 'GETBUNDLE':
              await this.getBundle(ws, request, user, ws.projectId);
              break;
            case 'SAVEBUNDLE':
              await this.saveBundle(ws, request, user, ws.projectId);
              break;
            default:
              this.sendError(ws, request.callbackID, 'Unknown command');
              break;
          }
        } catch (error) {
          //details stay in the log, they may contain server paths
          this.addLog("Error handling "+(request?.type || "unparseable")+" request: "+(error?.stack || error), "error");
          this.sendError(ws, request?.callbackID, 'Request failed.');
        }
      });

      //without an 'error' listener, ws emits unhandled 'error' events on receiver
      //protocol errors / send-after-close, which terminate the whole node process
      ws.on('error', (err) => {
        this.addLog('WebSocket connection error: '+(err?.message || err), "warn");
      });

      ws.on('close', (code, reason) => {
        this.addLog('Client disconnected');
        this.addLog('Close code: '+code+', reason: '+reason, "debug");
      });
    });
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

    // Send GETGLOBALDBCONFIG response
    const globalDBConfigResponse = {
      callbackID,
      data: this.readDbConfig(projectId),
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

  async getBundle(ws, request, user, projectId) {
    const { name, session, callbackID } = request;

    let bundleBasename = name;
    let bundlePath = this.bundlePath(projectId, session, bundleBasename);

    let mediaUrl = process.env.MEDIA_FILE_BASE_URL+"/file/project/"+encodeURIComponent(projectId)+"/session/"+encodeURIComponent(session)+"/file/"+encodeURIComponent(bundleBasename+"."+AUDIO_FILE_EXTENSION);

    //read dbconfig file - this should always exist
    let emuDbConfig = null;
    try {
      emuDbConfig = this.readDbConfig(projectId);
    }
    catch(error) {
      this.addLog("Error reading DBconfig file: "+error, "error");
      this.sendError(ws, callbackID, 'Error reading DBconfig file.');
      return;
    }

    let trackFiles = [];
    emuDbConfig.ssffTrackDefinitions.forEach(trackDef => {
      let trackFilePath = safeJoinedPath(bundlePath, bundleBasename+"."+safePathComponent(trackDef.fileExtension, "fileExtension"));

      this.addLog("Attempting to read "+trackDef.name+" track file: "+trackFilePath, "debug");

      if(fs.existsSync(trackFilePath)) {
        this.addLog("Found "+trackDef.name+" track file: "+trackFilePath, "debug");
        let trackData = fs.readFileSync(trackFilePath);
        let trackDataBase64 = trackData.toString('base64');
        let trackFile = {
          data: trackDataBase64,
          encoding: "BASE64",
          fileExtension: trackDef.fileExtension,
        };
        trackFiles.push(trackFile);
      }
      else {
        this.addLog("Track file not found: "+trackFilePath, "warn");
      }
    });

    if(!fs.existsSync(safeJoinedPath(bundlePath, bundleBasename+"."+AUDIO_FILE_EXTENSION))) {
      this.addLog("Audio file not found in bundle "+bundlePath, "error");
      this.sendError(ws, callbackID, 'Audio file not found.');
      return;
    }

    //load the <bundlename>_annot.json data
    let annotationData = null;
    try {
      annotationData = this.getBundleAnnotationData(bundlePath, bundleBasename);
    }
    catch(error) {
      this.addLog("Error reading annotation file: "+error, "error");
      this.sendError(ws, callbackID, 'Error reading annotation file.');
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
    let annotationDataString = fs.readFileSync(safeJoinedPath(bundlePath, bundleName+"_annot.json"), 'utf8');
    let annotationData = JSON.parse(annotationDataString);
    return annotationData;
  }

  saveBundleAnnotationData(bundlePath, bundleName, annotationData) {
    fs.writeFileSync(safeJoinedPath(bundlePath, bundleName+"_annot.json"), JSON.stringify(annotationData, null, 2));
  }

  async saveBundle(ws, request, user, projectId) {
    const { type, callbackID } = request;
    let reqData = request.data;
    if(typeof reqData?.annotation?.name !== "string") {
      this.sendError(ws, callbackID, 'Invalid bundle data.');
      return;
    }
    let bundleName = reqData.annotation.name.replace(/_annot\.json$/, '');

    let bundlePath = this.bundlePath(projectId, reqData.session, bundleName);
    //never create bundles, only update existing ones
    if(!fs.existsSync(bundlePath)) {
      this.addLog("Refusing to save to non-existent bundle "+bundlePath, "warn");
      this.sendError(ws, callbackID, 'Bundle not found.');
      return;
    }

    //only the SSFF tracks declared in the database config may be written, and nothing else (e.g. the audio file)
    let allowedExtensions = this.readDbConfig(projectId).ssffTrackDefinitions.map(trackDef => trackDef.fileExtension);
    let ssffFiles = Object.values(reqData.ssffFiles || {});
    for(let ssffFile of ssffFiles) {
      if(!allowedExtensions.includes(ssffFile?.fileExtension) || ssffFile.encoding?.toUpperCase() !== "BASE64" || typeof ssffFile.data !== "string") {
        this.addLog("Refusing to save SSFF file with extension "+ssffFile?.fileExtension+" and encoding "+ssffFile?.encoding+" to "+bundlePath, "warn");
        this.sendError(ws, callbackID, 'Invalid SSFF file.');
        return;
      }
    }

    for(let ssffFile of ssffFiles) {
      let decodedData = Buffer.from(ssffFile.data, 'base64');
      fs.writeFileSync(safeJoinedPath(bundlePath, bundleName+"."+safePathComponent(ssffFile.fileExtension, "fileExtension")), decodedData);
    }

    this.saveBundleAnnotationData(bundlePath, bundleName, reqData.annotation);

    let bundleList = await this.db.collection("bundlelists").findOne({projectId: projectId, owner: user.username});
    if(bundleList) {
      bundleList.bundles.forEach((bundleListItem) => {
        if(bundleListItem.name == bundleName && bundleListItem.session == reqData.session) {
          bundleListItem.finishedEditing = reqData.finishedEditing ? true : false; //make sure it's a boolean
          bundleListItem.comment = typeof reqData.comment === "string" ? reqData.comment : "";
        }
      });

      await this.db.collection("bundlelists").updateOne(
        {projectId: projectId, owner: user.username},
        {$set: {bundles: bundleList.bundles}}
      );
    }
    else {
      this.addLog("Bundlelist not found when saving bundle", "error");
    }

    // Send SAVEBUNDLE response
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
    MongoClient.connect(process.env.MONGO_URI)
      .then(client => {
        this.addLog('Connected to MongoDB');

        // Select the database
        this.db = client.db(dbName);
      })
      .catch(err => {
        this.addLog('Failed to connect to MongoDB: '+(err?.message || err), "error");
        //A connect failure must not leave a half-alive server behind: every
        //database-backed request would fail forever while systemd reports the unit as
        //running. Exit non-zero so systemd's Restart=always retries the connection.
        process.exit(1);
      });
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
