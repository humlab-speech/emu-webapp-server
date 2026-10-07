/**
 * @description Authentication module for VISP.
 * Validates the PHP session ID against the MongoDB `users` collection: a
 * user is authenticated if a user document carries the same `phpSessionId`,
 * and authorized for a project if that user's username appears in the
 * `members` of the `projects` document with the requested id.
 * It does not call the PHP backend - the PHP API only maintains the
 * `phpSessionId` field that is matched here.
 */
class VispAuth {
    constructor(app) {
        this.app = app;
        this.name = "VispAuthModule";
        this.authCacheTimeout = 60*60*1000; // 1 hour
        this.authCache = [];
    }

    getUser(sessionId) {
      let user = this.authCache.find((element, index, array) => {
        if(element.sessionId == sessionId) {
          return this.authCache[index];
        }
      });

      if(!user) {
        return false;
      }
      return user.userSession;
    }

  async authenticateUser(phpSessionId, projectId) {
    if(!projectId) {
      return {
        authenticated: false,
        reason: "No project id provided"
      };
    }
    if(!phpSessionId) {
      return {
        authenticated: false,
        reason: "No PHP session id provided"
      };
    }
    //both end up in mongo filters, which must only ever receive plain values
    if(typeof projectId !== "string" || typeof phpSessionId !== "string") {
      return {
        authenticated: false,
        reason: "Invalid credentials"
      };
    }

    let mongo = this.app.db;

    /*
    this.app.db.collection('users').findOne({phpSessionId: ws.PHPSESSID}).then((user) => {
      if(user) {
        this.addLog("User "+user.eppn+" ("+user.username+") connected", "debug");
      } else {
        this.addLog("User not identified", "debug");
      }
    });
    */


    let users = await mongo.collection("users").find({
      phpSessionId: phpSessionId
    }).toArray();
    if(users.length == 0) {
      return {
        authenticated: false,
        reason: "User not identified"
      };
    }
    let user = users[0];

    let projectsResult = await mongo.collection("projects").find({
      id: projectId,
      "members.username": user.username
    }).toArray();
    

    if(projectsResult.length == 0) {
      return {
        authenticated: false,
        reason: "User not authorized to access the project with id "+projectId
      };
    }

    this.app.addLog("Authenticated user "+user.eppn+" ("+user.username+")");

    return {
      authenticated: true,
      user: user
    };
  }

  authCacheGetAuthorization(sessionId, projectId) {
    this.authCache.find((element, index, array) => {
        if(element.sessionId == sessionId && element.projectId == projectId) {
            if(this.authCache[index].timestamp < new Date().getTime() - this.authCacheTimeout) {
                return this.authCache[index];
            }
            else {
                return false;
            }
        }
    });
  }

  updateAuthCache(sessionId, projectId, userSession) {
    let found = false;
    this.authCache.find((element, index, array) => {
        if(element.sessionId == sessionId && element.projectId == projectId) {
            found = true;
            this.authCache[index].timestamp = new Date().getTime();
        }
    });

    if(!found) {
        this.authCache.push({
            sessionId: sessionId,
            projectId: projectId,
            userSession: userSession,
            timestamp: new Date().getTime()
        });
    }
  }

}

//module.exports = VispAuth;

export default VispAuth;