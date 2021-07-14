
// Helper for DOM access
const $ = (query) => document.querySelector(query);

const HtmlUtil = {
    strong(text) { 
        const strong = document.createElement("strong");
        strong.textContent = text;
        return strong;
    }
};

if (TRANSLATE === undefined)
    TRANSLATE = {
        mediaError(e) { return `Error while opening your camera and microphone: ${e}`; },
        reset(user) { return `${user} has reset the whiteboard.`; },
        join(user) { return `${user} has joined the room.`; },
        leave(user) { return `${user} has left the room.`; },
        downloading() { return `Downloading...`; },
        downloadLocal() { return `Download (local)`; },
    }

async function InitSignalingSession() {// First, we ask the room ID, password, etc, by displaying a popup.
    const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";
    const SERVER_URL = `${WS_PROTOCOL}//${window.location.host}/ws/`;

    const form = $("#joinForm");
    const formPopup = new jvPopup(form);
    let signalingSession = null;
    while (true) {
        const formData = await formPopup.display("keep");
        try {
            const action = formData.get("action");
            const roomID = formData.get("roomID");
            const password = formData.get("password");
            const username = formData.get("username");
            // We try to create/join a room (exception thrown if we could not do it).
            if (action === "create") {
                signalingSession = await jvSession.create(SERVER_URL, "jv-whiteboard", password, username);
            } else if (action === "join") {
                signalingSession = await jvSession.join(SERVER_URL, "jv-whiteboard", roomID, password, username);
            } else {
                throw new Error(`Unkown action ${action}...`);
            }
            // No exception occured, we are connected to the signaling server.
            break;
        } catch(e) {
            alert(e.toString());
        }
        // If an exception was catched, we ask again.
        continue;
    }
    formPopup.destroy(); // the popup is not needed anymore.
    return signalingSession;
}

async function SetupCameras(rtc) {
    const cameras = $("#cameras");

    // Called when someone opens a stream, i.e. to respond to a "sendmevideo" message.
    rtc.onStreamBegin = (from, stream) => {
        // creating <div><video></video><p></p></div>
        const div = cameras.appendChild(document.createElement("div"));
        const video = div.appendChild(document.createElement("video"));
        video.setAttribute("autoplay", "");
        video.setAttribute("controls", "");
        video.srcObject = stream;
        if (from === rtc.username) video.volume = 0; // we do not want to echo ourself

        const p = div.appendChild(document.createElement("p"));
        p.textContent = from;

        return div;
    };
    // Called when the stream is closed, 'div' is the returned value from onStreamBegin;
    rtc.onStreamEnd = (from, div) => {
        cameras.removeChild(div);
    };

    try {
        const mymedia = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 300, height: 150 }});
        // if we could open the stream, broadcast it to all peers.
        rtc.beginStream(null, mymedia);
        // if we could open the stream, be prepared to answer "sendmevideo" messages.
        rtc.receptionHandlers.add((from, {sendmevideo}) => {
            if (sendmevideo) rtc.beginStream(from, mymedia);
        });
    } catch(e) {
        // we could not open the stream, notify the user.
        alert(TRANSLATE.mediaError(e.toString()));
    }
    // ask other peers their videos
    rtc.send(null, {sendmevideo: true});
}

async function SetupChat(rtc) {
    const displayMessage = (from, message, isMeta) => {
        const div = document.createElement("div");
        if (from) 
            div.appendChild(HtmlUtil.strong(`${from}: `));
        div.appendChild(document.createTextNode(message));
        if (isMeta) div.className = "meta";
        $('#chat').appendChild(div);
    };

    const msgInput = $("#chatInputMessage");

    $("#chatInput").onsubmit = event => {
        event.preventDefault();
        rtc.send(null, {chat: msgInput.value});
        msgInput.value = "";
    };

    msgInput.onkeydown = event => {
        if (event.key === "Enter" && !event.shiftKey)
            $("#chatInput").onsubmit(event);
    };

    rtc.receptionHandlers.add((from, {chat, svg}) => {
        // Reacting to message sent.
        if (chat) displayMessage(from, chat, false);
        // Reacting to reset whiteboard.
        if (svg && svg.reset) displayMessage(null, TRANSLATE.reset(from), true);
    });
    // Reacting to join/leave
    rtc.onJoin = user => {
        displayMessage(null, TRANSLATE.join(user), true);
    };
    rtc.onLeave = user => {
        displayMessage(null, TRANSLATE.leave(user), true);
    };
}

async function SetupFiles(rtc) {
    // Dictionnary {user: [[<button>,<progress>]|ObjectURL, ...], ...}
    const availableFiles = {};
    const myFiles = [];
    let index = 0;

    availableFiles[rtc.username] = [];
    
    // When the user submits a file, we send a {new_file:{...}} message.
    $("#fileButton").onclick = async () => {
        let formData =  await new jvPopup($("#shareFile")).display();
        if (formData.get("_submit_") === "share") {
            const file = formData.get("file");
            if (!file) return; // do nothing if no file submitted
            myFiles[++index] = file;
            rtc.send(null, {new_file: {id: index, name: file.name, size: file.size, type: file.type }});
        }
    };


    // When we receive a {new_file:{...}} message, displaying it in the chat.
    // When we receive a {ask_file:{...}} message, sending file.
    rtc.receptionHandlers.add((from, {new_file, ask_file}) => {
        // Creating a message in chat for new_file 
        if (new_file) {
            const msg = $("#chat").appendChild($("#fileSharedMsg").cloneNode(true));
            msg.querySelector(".user").textContent = from;
            msg.querySelector(".file").textContent = new_file.name;
            const button = msg.querySelector("button");
            const progress = msg.querySelector("progress");
            progress.value = 0;
            progress.max = new_file.size;
            
            if (availableFiles[from] == undefined)
                availableFiles[from] = [];
            availableFiles[from][new_file.id] = [button, progress];

            button.onclick = () => {
                rtc.send(from, {ask_file: new_file.id });
                button.disabled = true;
                button.textContent = TRANSLATE.downloading();
                progress.style.display = "";
            };
        }

        if (ask_file) 
            rtc.sendFile(from, myFiles[ask_file], ask_file);
    });

    // When receiving files
    rtc.onFileReception = (from, file, id) => {
        // must setTimeout, else button will not be updated again (why?)
        setTimeout(() => {
            const [button, progress] = availableFiles[from][id];
            const url = URL.createObjectURL(file);
            availableFiles[from][id] = url;
            progress.style.display = "none";
            
            button.disabled = false;
            button.textContent = TRANSLATE.downloadLocal();
            button.onclick = () => {
                // if the user wants to download it again
                const a = document.createElement("a");
                a.href = url;
                a.download = file.name;
                a.click();
            };
            button.onclick();
        });
    };
}

async function SetupSVG(rtc) {
    // create the SVG element
    const svg = SVG().addTo("#whiteboard").size("100%", "100%");
    const svgElem = $("svg");

    // Tools reactions to category changes
    $("#toolCategory").onchange = () => {
        const category = this.toolCategory.value;
        $("#toolThickness").style.display = ["filledRect", "filledCircle", "text"].includes(category) ? "none" : "";
        $("#toolText").style.display = (category === "text" ? "" : "none");
        $("#toolSize").style.display = (category === "text" ? "" : "none");
    };
    $("#toolCategory").onchange(); // ensure cached form will not mess up

    // Global actions handlers
    $("#resetButton").onclick = async () => {
        let formData = await new jvPopup($("#resetConfirm")).display();
        if (formData.get("_submit_") === "reset")
            rtc.send(null, {svg: {reset: true}});
    };
    $("#saveButton").onclick = () => saveSvgAsPng(svgElem, "whiteboard.png");

    // Storing all figures, so a new comer can ask us the current whiteboard state.
    let history = [];
    // Storing all currently editing figures for everyone.
    const cursors = {};

    // Figure creations.
    const handleCreate = {
        pencil: ({pos,stroke}) => svg.polyline(`${pos[0]},${pos[1]}`).fill("none").stroke(stroke),
        line: ({pos,stroke}) => svg.line(...pos, ...pos).stroke(stroke),
        emptyRect: ({pos,stroke}) => svg.rect(0,0,0,0).move(...pos).fill("none").stroke(stroke),
        filledRect: ({pos,stroke}) => svg.rect(0,0,0,0).move(...pos).fill(stroke),
        emptyCircle: ({pos,stroke}) => svg.ellipse(0,0).move(...pos).fill("none").stroke(stroke),
        filledCircle: ({pos,stroke}) => svg.ellipse(0,0).move(...pos).fill(stroke),
        text: ({pos,text,stroke,size}) => svg.text(text).move(...pos).font(
                    { fill: stroke.color, "font-size": size, "fill-opacity": stroke.opacity }),
    };

    const handleMessage = (user, {askHistory, reset, create, update, end}) => {
        if (askHistory) {
            // reply with our history
            rtc.send(user, {svg: {history: history.map(figure => {
                return { from: figure.from, create: figure.create, attr: figure.attr, isDone: figure.isDone };
            })}});
        }
        else if (reset) {
            history = [];
            svg.clear();
        }
        else if (create) {
            const elem = handleCreate[create.kind](create);
            history.push({ elem: elem, from: user, create: create, attr: {}, isDone: false});
            cursors[user] = history[history.length - 1];
        }
        else if (update) {
            const figure = cursors[user];
            figure.elem.attr(update);
            figure.attr = { ...figure.attr, ...update };
        }
        else if (end) {
            cursors[user].isDone = true;
            cursors[user] = null;
        }
    };

    if (rtc.getPeers().size > 1) { // we are not alone, ask someone about the history
        // Storing messages received before history.
        const waitingMsgs = [];

        // Waiting for someone sending history
        const { history, historyHandler } = await new Promise((resolve,reject) => {
            let historyFound = false;
            const historyHandler = (from, {svg}) => {
                if (!svg) return;
                if (svg.history) {
                    // Ensuring we are not treating twice the history (i.e. from two peers)
                    if (historyFound) return;
                    historyFound = true;
                    resolve({history: svg.history, handler: historyHandler});
                } else {
                    // Cannot handle it without history
                    waitingMsgs.push({from: from, svg: svg});
                }
            };
            rtc.receptionHandlers.add(historyHandler);
            rtc.send(null, {svg: {askHistory: true}});
        });

        // Recreating the whiteboard figure by figure
        for (let { from, create, attr, isDone } of history) {
            handleMessage(from, {create: create});
            handleMessage(from, {update: attr});
            if (isDone)
                handleMessage(from, {end: true});
        }
        // Handling waiting messages
        for (let { from, svg } of waitingMsgs)
            handleMessage(from, svg);
        // Receive messages directly without using 'waitingMsgs'
        rtc.receptionHandlers.delete(historyHandler);
    }
    rtc.receptionHandlers.add((from, {svg}) => { if (svg) handleMessage(from, svg); });

    let cursorInfo = null; // useful to store data while editing a figure.

    // Emitting our own events:

    // Creation of figures
    svgElem.onmousedown = (e) => {
        const svgRect = svgElem.getBoundingClientRect();
        const pos = [ e.clientX - svgRect.left, e.clientY - svgRect.top ];
        const stroke = {color: $("#toolColor").value, opacity: $("#toolOpacity").value, width: $("#toolThickness").value, linecap: "round"};
        const msg = {create: {kind: $("#toolCategory").value, stroke: stroke, pos: pos}};
        cursorInfo = "";
        switch (msg.create.kind) {
            case "emptyRect": case "filledRect": case "emptyCircle": case "filledCircle":
                cursorInfo = pos;
                break;
            case "text":
                msg.create.text = this.toolText.value;
                msg.create.size = this.toolSize.value;
                break;
        }
        rtc.send(null, {svg: msg});
    };

    // Edition of figures
    svgElem.onmousemove = (e) => {
        if (cursorInfo === null) return;
        const svgRect = svgElem.getBoundingClientRect();
        const pos = [ e.clientX - svgRect.left, e.clientY - svgRect.top ];
        switch ($("#toolCategory").value) {
            case "pencil":
                cursorInfo = `${cursorInfo} ${pos[0]},${pos[1]}`;
                rtc.send(null, {svg: {update: {points: cursorInfo}}});
                break;
            case "line":
                rtc.send(null, {svg: {update: {x2: pos[0], y2: pos[1]}}});
                break;
            case "emptyRect":
            case "filledRect": {
                const x1 = Math.min(cursorInfo[0], pos[0]), x2 = Math.max(cursorInfo[0], pos[0]);
                const y1 = Math.min(cursorInfo[1], pos[1]), y2 = Math.max(cursorInfo[1], pos[1]);
                rtc.send(null, {svg: {update: {x: x1, y: y1, width: x2-x1, height: y2-y1 }}});
                break; }
            case "emptyCircle":
            case "filledCircle": {
                const x1 = Math.min(cursorInfo[0], pos[0]), x2 = Math.max(cursorInfo[0], pos[0]);
                const y1 = Math.min(cursorInfo[1], pos[1]), y2 = Math.max(cursorInfo[1], pos[1]);
                rtc.send(null, {svg: {update: { cx: (x1+x2)/2, cy: (y1+y2)/2, rx: (x2-x1)/2, ry: (y2-y1)/2 }}});
                break; }
            case "text": {
                rtc.send(null, {svg: {update: {x: pos[0], y: pos[1]}}});
                break;
            }
        }
    };

    svgElem.onmouseup = (e) => {
        rtc.send(null, {svg: {stop: true}});
        cursorInfo = null;
    };
}

(async function () {
    // We initialize a WebRTC session over the signaling session.
    const rtc = await jvSessionRTC.wrap(await InitSignalingSession());
    // Each handler registered in rtc.receptionHandlers will be called by rtc.onReception()
    rtc.receptionHandlers = new Set();
    rtc.onReception = (from, msg) => rtc.receptionHandlers.forEach(handler => handler(from, msg));
    $("#roomID").textContent = `ID: ${rtc.id}`;
    $("#main").style.display = "";

    SetupCameras(rtc);
    SetupChat(rtc);
    SetupSVG(rtc);
    SetupFiles(rtc);
})();
