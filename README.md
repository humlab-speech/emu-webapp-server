# EMU-webapp-server (VISP)

Local development URL:

https://emu-webapp.visp.local/?autoConnect=true&serverUrl=wss:%2F%2Femu-webapp.visp.local

## Assumptions made
* There's a mongodb with a 'projects' collection containing the project metadata following the Gitlab format.
* The EMU-DB files are stored in git repositories as a files on a drive. The directory structure is available at /repositories and are stored according to the pattern: /repositories/<username>/<projectname>/Data/VISP_emuDB.

## Authentication modules
You need to have an authentication module to authorize the user and fetch their information from your user management system. In our case it's a PHP backend, but it can be anything.

The module needs to implement the methods authenticateUser(sessionId, projectId) and getUser(sessionId).

authenticateUser should make sure that:
1. This session id can be tied to a valid user session.
2. This user also has access to the project in question.

If both of these are true it should return the user metadata, like this:
```
{
    authenticated: true,
    user: {
        username: username,
        email: email,
    }
}
```

If one of these is false it should reject the authentication and return the reason as to why, like this:
```
{
    authenticated: false,
    reason: "No PHP session id provided"
}
```

In both cases it should return these js objects in the form of a promise.

The getUser method is a simpler non-promise version that only returns the user if it is already available in an internal cache. So, if/when the authenticateUser method has done its thing, it's expected to keep all the authenticated users in some sort of cache and return them on request to the getUser method.

That was a terrible way to explain all this, sorry, I didn't have time to write a short explanation so I wrote a long one.