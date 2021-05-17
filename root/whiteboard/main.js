

const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";
const SERVER_URL = `${WS_PROTOCOL}//${window.location.host}/ws/`;

class jvWhiteboard {
    
    async init(session) {
        this._session = session;
        this._session.onJoin = (...a) => this.onJoin(...a);
        this._session.onLeave = (...a) => this.onLeave(...a);
        this._session.onReception = (...a) => this.onReception(...a);

        this._username = this._session.username;

        document.getElementById("roomID").textContent = this._session.id;

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
        

        for (let user of this._session.getUsers()) {
            if (user === this._username) continue;
            this._setupPeer(user);
        }
        let {video} = this._createVideoFor(this._username);
        video.srcObject = this._mymedia;
        
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

    onReception(from, {chat, sendmevideo}) {
        if (chat) {
            this.pushChatMessage(from, chat, false);
        } else if (sendmevideo !== undefined) {
            console.log("received", from, this._cameras);
            if (!this._cameras[from]) this._setupPeer(from);
            const peer = this._session.getPeer(from);
            for (let track of this._mymedia.getTracks())
                peer.addTrack(track, this._mymedia);
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