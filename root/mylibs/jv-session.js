/* By Julien Vernay ( jvernay.fr ). Under GNU AGPL v3. */
// Responsible for creating and joining sessions (client direct counterpart to server/main.py)

class jvSession {
    // Creates a session on the provided server, and joins it with the given username.
    // 'appname' should be hardcoded: each different use of the websocket server should use a different string for it.
    // It is like a namespace for session IDs, so different apps will not join the same session.s
    // Returns the session. Share "session.id" so other users can join it.
    // Throws if a session could not be created.
    static async create(websocket_url, appname, password, username) {
        return await new jvSession()._init(websocket_url, appname, null, password, username);
    }

    // Joins an existing session on the provided server, using the given id.
    // Returns the session. Throws if ID not found, password invalid, or username already taken.
    static async join(websocket_url, appname, sessionID, password, username) {
        return await new jvSession()._init(websocket_url, appname, sessionID, password, username);
    }

    // Returns the list of usernames, ordered chronologically by arrivals.
    // Synchronized because it uses a cache.
    // The cache is updated BEFORE calling onJoin/onLeave (so calling getUsers() from these callbacks is relevant).
    getUsers() {
        return this._users;
    }

    // Send a message to a user. Does not check if the user actually exist (in which case, the message will be discarded).
    // The users can react to messages by overriding "onReception".
    // Passing user=null will cause a broadcast (message sent to all users, including itself).
    send(user, msg) {
        this.ws.send(JSON.stringify({
            action: "send", user: user, message: msg,
        }));
    }

    // Send a request to a user, and returns when a response is received.
    // The users can react to request by overriding "onRequest".
    // Passing user=null is NOT allowed.
    async ask(user, msg) {
        let requestID = this._nextRequestID++;
        return await new Promise((resolve, reject) => {
            this._waitingRequests[requestID] = [resolve, reject];
            this.ws.send(JSON.stringify({
                action: "request", user: user, message: msg, id: requestID
            }));
        });
    }

    // Close the connection.
    close() { this.ws.close(); }

    // Called when a request is received. Should be overriden, e.g. "session.onRequest = async function(...) {...};".
    // You must return the response, which will be passed to the asker.
    async onRequest(from, msg) { return `REQUEST NOT HANDLED: ${msg}`; }

    // Called when a message (which is not a request) is received. Should be overriden.
    async onReception(from, msg) { console.log(`MESSAGE FROM ${from}: ${msg}`); }

    // Called when a user has joined the session. Should be overriden.
    async onJoin(username) { console.log(`${username} has joined the session.`); }

    // Called when a user has left the session. Should be overriden.
    async onLeave(username) { console.log(`${username} has left the session.`); }

    // Called when an error occurs which caused the websocket to close. Should be overriden.
    async onFatalError(error) {
        alert("[ERROR] Websocket closed:\n" + error);
        throw new Error(error);
    }

    // Called when an error occurs, which would be ignored. Can be overriden.
    async onError(error) {
        console.error(error);
    }


    ////// PRIVATE //////

    // Initializes the session. If sessionId=null, will try to create a session before joining it.
    // Returns itself.
    async _init(websocket_url, appname, sessionId, password, username) {
        try {
            // First, open the websocket
            await new Promise((resolve,reject) => {
                this.ws = new WebSocket(websocket_url);
                this.ws.onerror = reject;
                this.ws.addEventListener("open", resolve, {once: true});
            });

            // Then, init the session and store its informations (id and _users)
            await new Promise((resolve, reject) => {
                this.ws.onerror = reject;
                
                this.ws.addEventListener("message", event => {
                    const response = JSON.parse(event.data);
                    if (response.error)
                        reject(new Error(response.error));
                    this.id = response.id;
                    this.username = username;
                    this._users = response.users;
                    resolve();
                }, {once: true});

                if (sessionId === null)
                    this.ws.send(JSON.stringify({
                        action: "create", password: password, username: username, appname: appname,
                    }));
                else 
                    this.ws.send(JSON.stringify({
                        action: "join", id: sessionId, password: password, username: username, appname: appname,
                    }));
            });

            this.ws.onerror = this.onFatalError;
            this.ws.onmessage = event => this._onMessage(JSON.parse(event.data));

            this._nextRequestID = 1;
            this._waitingRequests = {};

            return this;
        } catch (e) {
            if (e.target instanceof WebSocket)
                throw new Error(`Cannot connect to websocket server "${e.target.url}".`);
            else
                throw e;
        }
    }

    // Responsible for dispatching all received messages after initialization.
    async _onMessage(msg) {
        if (msg.request !== undefined) {
            const response = await this.onRequest(msg.from, msg.request);
            this.ws.send(JSON.stringify({
                action: "response", user: msg.from, message: response, id: msg.id,
            }));
        } else if (msg.response !== undefined) {
            let id = Number(msg.id);
            let requestHandler = this._waitingRequests[id];
            requestHandler[0](msg.response);
            delete this._waitingRequests[id];
        } else if (msg.error !== undefined) {
            if (msg.id) {
                let id = Number(msg.id);
                let requestHandler = this._waitingRequests[id];
                requestHandler[1](msg.error);
                delete this._waitingRequests[id];
            } else {
                this.onError(msg.error);
            }
        } else if (msg.message !== undefined) {
            this.onReception(msg.from, msg.message);
        } else if (msg.joined !== undefined) {
            this._users = msg.users;
            this.onJoin(msg.joined);
        }
        else if (msg.left !== undefined) {
            this._users = msg.users;
            this.onLeave(msg.left);
        }
    }

}