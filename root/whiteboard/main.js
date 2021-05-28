

const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";
const SERVER_URL = `${WS_PROTOCOL}//${window.location.host}/ws/`;


// Responsible for all SVG manipulations
class jvWhiteboardSVG {
    // 'isAlone' determines whether the SVG will ask an history to peers.
    // 'sendMessage(dest, msg)' is called when the SVG state is modified.
    // 'msg' must be transmitted to 'dest', or broadcasted if 'dest === null',
    // by calling "messageReception" on the peers' SVG.
    constructor(isAlone, sendMessage) {

        this.toolCategory = document.getElementById("toolCategory");
        this.toolThickness = document.getElementById("toolThickness");
        this.toolColor = document.getElementById("toolColor");
        this.toolOpacity = document.getElementById("toolOpacity");

        this.svg = SVG().addTo("#whiteboard").size("100%", "100%");
        this.svgCursor = null; // current form we are drawing

        this.svgElem = document.getElementsByTagName("svg")[0];
        this.svgElem.addEventListener("mousedown", e => this._mouseDown(e));
        this.svgElem.addEventListener("mousemove", e => this._mouseMove(e));
        this.svgElem.addEventListener("mouseup", e => this._mouseUp(e));


        // array of { elem, create, attr, isDone }, transmitted to other peers.
        this._history = [];

        // array of incoming messages which cannot be processed at the time (because we want to process history first).
        // 'null' when messages can be handled directly.
        this._incoming = isAlone ? null : [];
        
        // dictionnary { username: historyIndex }, mapping peers to currently editing figure.
        this._cursors = {};

        // store client position of SVG element, supposed constant when drawing
        this.svgRect = null;

        this._sendMessage = sendMessage;
        
        console.log(isAlone);
        if (!isAlone)
            this._sendMessage(null, {askHistory: true});
    }


    messageReception(from, msg) {
        if (this._incoming !== null) {
            if (msg.history) {
                // let's "receive" the history one by one
                for (let { from, create, attr, isDone } of msg.history) {
                    this.messageReception(from, {create: create});
                    this.messageReception(from, {update: attr});
                    if (isDone)
                        this.messageReception(from, {end: true});
                }
                let incoming = this._incoming;
                this._incoming = null;
                // let's receive unhandled messages
                for (let {from, msg} of incoming)
                    this.messageReception(from, msg);
            } else {
                this._incoming.push({from: from, msg: msg});
            }
            return;
        }
        if (msg.history) {
            return; // we already received one history, discard others
        }
        else if (msg.askHistory) {
            // reply with our history
            this._sendMessage(from, {history: this._history.map(figure => {
               return { from: figure.from, create: figure.create, attr: figure.attr, isDone: figure.isDone };
            })});
        }
        else if (msg.create) {
            const pos = msg.create.pos;
            let elem;
            switch (msg.create.kind) {
                case "pencil":
                    elem = this.svg.polyline(`${pos[0]},${pos[1]}`).fill("none").stroke(msg.create.stroke);
                    break;
                case "line":
                    elem = this.svg.line(...pos, ...pos).stroke(msg.create.stroke);
                    break;
            }
            this._history.push({ elem: elem, from: from, create: msg.create, attr: {}, isDone: false});
            this._cursors[from] = this._history.length - 1;
        }
        else if (msg.update) {
            const figure = this._history[this._cursors[from]];
            figure.elem.attr(msg.update);
            figure.attr = { ...figure.attr, ...msg.update };
        }
        else if (msg.end) {
            this._history[this._cursors[from]].isDone = true;
            this._cursors[from] = null;
        }
    }


    _mouseDown(e) {
        this.svgRect = this.svgElem.getBoundingClientRect();
        const pos = [ e.clientX - this.svgRect.left, e.clientY - this.svgRect.top ];
        const stroke = {color : this.toolColor.value, opacity: this.toolOpacity.value, width: this.toolThickness.value, linecap: "round"};
        this._cursorInfo = "";
        this._sendMessage(null, {create: {kind: this.toolCategory.value, stroke: stroke, pos: pos}});
    }
    _mouseMove(e) {
        if (this.svgRect === null) return;
        const pos = [ e.clientX - this.svgRect.left, e.clientY - this.svgRect.top ];
        switch (this.toolCategory.value) {
            case "pencil":
                this._cursorInfo = `${this._cursorInfo} ${pos[0]},${pos[1]}`;
                this._sendMessage(null, {update: {points: this._cursorInfo}});
                break;
            case "line":
                this._sendMessage(null, {update: {x2: pos[0], y2: pos[1]}});
                break;
        }
    }
    _mouseUp(e) {
        this._sendMessage(null, {stop: true});
        this.svgRect = null;
    }
}

class jvWhiteboard {
    
    async init(session) {
        this._session = session;
        this._session.onJoin = (...a) => this.onJoin(...a);
        this._session.onLeave = (...a) => this.onLeave(...a);
        this._session.onReception = (...a) => this.onReception(...a);

        this._username = this._session.username;

        document.getElementById("roomID").textContent = `ID: ${this._session.id}`;

        document.getElementById("main").style.display = "";
        this._chatOutput = document.getElementById("chat");

        this._chatInputMessage = document.getElementById("chatInputMessage");
        this._chatInputMessage.addEventListener("keydown", event => {
            if (event.key === "Enter" && !event.shiftKey)
                this.onChatSubmit(event);
        });

        document.getElementById("chatInput").addEventListener("submit", event => this.onChatSubmit(event));

        // Camera
        this._camerasElem = document.getElementById("cameras");
        this._cameras = {};

        try {
            this._mymedia = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 300, height: 150 }});
        } catch(e) {
            this._mymedia = null;
            alert("Error while opening your camera and microphone");
        }
        

        let nbUsers = 0;
        for (let user of this._session.getUsers()) {
            ++nbUsers;
            if (user === this._username) continue;
            this._setupPeer(user);
        }
        let {video} = this._createVideoFor(this._username);
        video.srcObject = this._mymedia;
        video.volume = 0; // we don't want to hear ourself

        this._svg = new jvWhiteboardSVG(nbUsers === 1, (dest, msg) => {
            this._session.send(dest, { svg: msg });
        });
        
        return this;
    }


    _createVideoFor(username) {
        const div = this._camerasElem.appendChild(document.createElement("div"));

        const video = div.appendChild(document.createElement("video"));
        video.setAttribute("autoplay", "");
        video.setAttribute("controls", "");

        const p = div.appendChild(document.createElement("p"));
        p.textContent = username;

        this._cameras[username] = { div: div, video: video };

        return this._cameras[username];
    }

    _setupPeer(user) {
        const peer = this._session.getPeer(user);
        let {video} = this._createVideoFor(user);
        peer.ontrack = event => {
            console.log("received", event.track);
            video.srcObject = event.streams[0];
        };
        console.log("sendmevideo", user);
        this._session.send(user, {sendmevideo:""});
    }

    pushChatMessage(from, message, isMeta) {
        const div = document.createElement("div");
        if (from) {
            const name = document.createElement("strong");
            name.textContent = `${from}: `;
            div.appendChild(name);
        }
        div.appendChild(document.createTextNode(message));
        if (isMeta) div.className = "meta";
        this._chatOutput.appendChild(div);
    }

    onChatSubmit(event) {
        event.preventDefault();
        const msg = this._chatInputMessage.value;
        this._session.send(null, { "chat": msg });
        this._chatInputMessage.value = "";
    }

    onReception(from, {chat, sendmevideo, svg}) {
        if (chat) {
            this.pushChatMessage(from, chat, false);
        } else if (sendmevideo !== undefined) {
            console.log("received", from, this._cameras);
            if (!this._cameras[from]) this._setupPeer(from);
            const peer = this._session.getPeer(from);
            for (let track of this._mymedia.getTracks())
                peer.addTrack(track, this._mymedia);
        } else if (svg !== undefined) {
            if (from === this._username && svg.askHistory)
                return; // we cannot reply to our history request
            this._svg.messageReception(from, svg);
        }
    }

    onJoin(user) {
        this.pushChatMessage(null, `${user} has joined the room.`, true);
    }

    onLeave(user) {
        this.pushChatMessage(null, `${user} has left the room.`, true);
        this._camerasElem.removeChild(this._cameras[user].div);
        delete this._cameras[user];
    }

    static async askRoom() {
        const form = document.getElementById("joinForm");
        const formPopup = new jvPopup(form);
        let session = null;
        while (true) {
            const formData = await formPopup.display("keep");
            try {
                const action = formData.get("action");
                const roomID = formData.get("roomID");
                const password = formData.get("password");
                const username = formData.get("username");
                if (action === "create") {
                    session = await jvSession.create(SERVER_URL, "jv-whiteboard", password, username);
                } else if (action === "join") {
                    session = await jvSession.join(SERVER_URL, "jv-whiteboard", roomID, password, username);
                } else {
                    throw new Error(`Unkown action ${action}...`);
                }
                break;
            } catch(e) {
                alert(e.toString());
            }
        }
        formPopup.destroy();
        return await new jvWhiteboard().init(await jvSessionRTC.wrap(session));
    }

}


let whiteboard = null; // storing whiteboard for debugging purposes in browser console.
jvWhiteboard.askRoom().then(w => { whiteboard = w; });