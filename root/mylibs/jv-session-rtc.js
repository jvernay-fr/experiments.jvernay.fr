/* By Julien Vernay ( jvernay.fr ). Under GNU AGPL v3. */
// Responsible for creating and joining peer-to-peer sessions over WebRTC.
// Signaling between peers is done with reguler jv-session.js, which is a dependency.
// Essentially mimics jvSession, but as peer-to-peer.

_JVRTC_PEER_CONFIGURATION = {'iceServers': [{'urls': 'stun:stun.l.google.com:19302'}]}

class jvSessionRTC {

    // Uses an existent jvSession as signaling server to create a peer-to-peer jvSessionRTC.
    static async wrap(signaling_session) {
        return await new jvSessionRTC()._init(signaling_session);
    }

    // Returns a Map of (username => RTCPeerConnection), ordered chronologically by arrivals.
    getPeers() {
        return this._peers;
    }

    // Returns the list of usernames, ordered chronologically by arrivals.
    getUsers() {
        return this._peers.keys();
    }

    // Returns the RTCPeerConnection associated to this user.
    getPeer(username) {
        return this._peers.get(username);
    }

    // Send a message to a user. Does not check if the user actually exist (in which case, the message will be discarded).
    // The users can react to messages by overriding "onReception".
    // Passing user=null will cause a broadcast (message sent to all users, including itself).
    send(user, message) {
        const message_json = JSON.stringify({ message: message });
        if (user === null) {
            this._peers.forEach(peerConnection => {
                if (peerConnection !== null) {
                    peerConnection.jvrtc_datachannel.send(message_json);
                }
            });
            this.onReception(this.username, message);
        } else if (user === this.username) {
            this.onReception(this.username, message);
        } else {
            this._peers.get(user).jvrtc_datachannel.send(message_json);
        }
    }

    // Starts to share a MediaStream to a user. Does not check if the user actually exist.
    // The recipient can react by overriding "onStreamBegin".
    // Passing user=null will cause a broadcast (MediaStream sent to all users, including itself).
    beginStream(user, mediaStream) {
        if (user === null) {
            for (let user of this.getUsers()) this.beginStream(user, mediaStream);
        } else if (user === this.username) {
            this._onTrack(this.username, null, [mediaStream]);
        } else {
            for (let track of mediaStream.getTracks())
                this._peers.get(user).addTrack(track, mediaStream);
        }
    }
    // Stops sharing a MediaStream to a user.
    // The recipient can react by overriding "onStreamEnd".
    endStream(user, mediaStream) {
        if (user === null) {
            for (let user of this.getUsers()) this.endStream(user, mediaStream);
        } else if (user === this.username) {   
            this.onStreamEnd(user, mediaStream);
            delete this._streams[mediaStream.id];
            this._streamsPerUser[user].delete(mediaStream.id);
        } else {
            this._peers.get(user).jvrtc_datachannel.send(JSON.stringify({endStream: mediaStream.id}));
        }
    }

    async sendFile(user, file, data) {
        if (user === null) {
            for (let user of this.getUsers()) this.sendFile(user, file, data);
        } else if (user === this.username) {
            this.onFileReception(user, file, data);
        } else {
            const fileChannel = this._peers.get(user).createDataChannel("_jvrtc_file");

            await new Promise((resolve,reject) => {
                fileChannel.onmessage = event => resolve(event.data);
                fileChannel.onopen = () => fileChannel.send(JSON.stringify({
                    name: file.name, size: file.size, type: file.type, data: data,
                }));
            });

            await new Promise((resolve, reject) => {
                fileChannel.onmessage = event => resolve(event.data);
                const chunkSize = 16000;
                const nbFullChunks = Math.floor(file.size / chunkSize);
                for (let i = 0; i < nbFullChunks; ++i) {
                    fileChannel.send(file.slice(i*chunkSize, (i+1)*chunkSize));
                }
                fileChannel.send(file.slice(nbFullChunks*chunkSize));
            });
        }
    }

    // Send a request to a user, and returns when a response is received.
    // The users can react to request by overriding "onRequest".
    // Passing user=null is NOT allowed.
    async ask(user, msg) {
        throw new Error("NOT IMPLEMENTEND");
        
    }

    // Close the connections.
    close() {
        this._peers.forEach(peerConnection => peerConnection.close());
        this._signaler.close();
    }

    // Called when a request is received. Should be overriden, e.g. "session.onRequest = async function(...) {...};".
    // You must return the response, which will be passed to the asker.
    async onRequest(from, msg) { return `REQUEST NOT HANDLED: ${msg}`; }

    // Called when someone starts a MediaStream. Should be overriden.
    // May return a value, which will be passed to the corresponding onStreamEnd().
    async onStreamBegin(from, mediaStream) { console.log(`STREAM FROM ${from} STARTED.`); }

    // Called when someone ends a MediaStream. Should be overriden.
    // 'data' is the value returned by onStreamBegin.
    async onStreamEnd(from, data) { console.log(`STREAM FROM ${from} ENDED.`); }

    // Called when a message (which is not a request) is received. Should be overriden.
    async onReception(from, msg) { console.log(`MESSAGE FROM ${from}: ${msg}`); }

    // Called when a message (which is not a request) is received. Should be overriden.
    async onFileReception(from, file, data) { console.log("FILE RECEIVED", from, file, data); }

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

    async _init(signaling_session) {
        jvSessionRTC.debug = this;
        this._signaler = signaling_session;
        this._signaler.onRequest = this._onSignalingRequest.bind(this);
        this._signaler.onReception = this._onSignalingReception.bind(this);
        this._signaler.onJoin = this._onSignalingJoin.bind(this);
        this._signaler.onLeave = this._onSignalingLeave.bind(this);

        this.id = this._signaler.id;
        this.username = this._signaler.username;

        this._peers = new Map(); // username => RTCPeerConnection

        this._waitingDataChannels = new Map(); // username => [resolve,reject]
        let waitingPromises = [];

        // Will contain all streams opened by peers.
        // _streamsPerUser will allow to properly close streams when a user suddenly disconnects.
        this._streams = {}; // streamId => value returned from onStreamBegin
        this._streamsPerUser = {}; // username => Set(streamId)

        for (let username of this._signaler.getUsers()) {
            this._streamsPerUser[username] = new Set();
            if (username === this.username) continue;

            waitingPromises.push(new Promise((resolve, reject) => {
                this._waitingDataChannels.set(username, [resolve, reject]);

                const peerConnection = this._initPeer(username, true); // is_initiator = true
                const dataChannel = peerConnection.createDataChannel("_jvrtc_main");
                peerConnection.jvrtc_datachannel = dataChannel;
                this._initDataChannel(username, dataChannel);
            }));
        }
        
        const results = await Promise.allSettled(waitingPromises);
        this._waitingDataChannels = null;

        this._peers.set(this.username, null); // So it appears in getUsers(), after everyone else

        return this;
    }

    _initPeer(username, is_initiator) {
        const peerConnection = new RTCPeerConnection(_JVRTC_PEER_CONFIGURATION);
        this._peers.set(username, peerConnection);
        // Handlers for negotiation
        peerConnection.onicecandidate = event => this._signaler.send(username, {_jvrtc_ice: event.candidate});
        peerConnection.onnegotiationneeded = () => this._makeNegotiation(username, peerConnection);
        // Additionnal data implementing the perfect negotiation pattern
        peerConnection.jvrtc_makingOffer = false; 
        peerConnection.jvrtc_polite = !is_initiator;
        // Handler for data channel
        peerConnection.ondatachannel = event => this._initDataChannel(username, event.channel);
        // Handler for tracks
        peerConnection.ontrack = event => this._onTrack(username, event.track, event.streams);

        return peerConnection;
    }

    _onTrack(username, track, streams) {
        for (let stream of streams) {
            if (stream.id in this._streams) continue;
            this._streams[stream.id] = this.onStreamBegin(username, stream);
            this._streamsPerUser[username].add(stream.id);
        }
    }

    _initDataChannel(username, channel) {
        if (channel.label === "_jvrtc_main") {
            this._peers.get(username).jvrtc_datachannel = channel;
            channel.onopen = (event) => this._onDataChannelOpen(username, event);
            channel.onmessage = event => this._onDataChannelMessage(username, channel, event);
            channel.onclose = () => this._onDataChannelClose(username);
            channel.onerror = event => this._onDataChannelError(event, username);
        } else {
            channel.onerror = event => this._onDataChannelError(event, username);

            let metadata = undefined;
            let chunks = [];
            let size = 0;

            
            channel.onmessage = event => {
                if (metadata === undefined) {
                    metadata = JSON.parse(event.data);
                    channel.send("ok");
                } else {
                    chunks.push(event.data);
                    size += event.data.size;
                    if (size === metadata.size) {
                        channel.send("ok");
                        let file = new File(chunks, metadata.name, {type: metadata.type});
                        this.onFileReception(username, file, metadata.data);
                    }
                }
            };
        }
    }

    async _onDataChannelOpen(username, event) {
        if (this._waitingDataChannels) {
            // we are the caller
            this._waitingDataChannels.get(username)[0](); // resolve
        } else {
            // we are the callee
            this.onJoin(username);
        }
    }

    async _onDataChannelClose(username) {
        this._peers.delete(username);
        this.onLeave(username);
    }

    async _onDataChannelError(event, username) {
        this.onError(`Error with connection of '${username}': ${event.toString()}`);
        if (!this._waitingDataChannels) return;
        this._waitingDataChannels.get(username)[1](event); // reject
    }

    async _onDataChannelMessage(username, channel, event) {
        const msg = JSON.parse(event.data);
        if (msg.message !== undefined)
            this.onReception(username, msg.message);
        else if (msg.endStream !== undefined) {
            this.onStreamEnd(username, this._streams[msg.endStream]);
            delete this._streams[msg.endStream];
            this._streamsPerUser[username].delete(msg.endStream);
        }
    }


    async _onSignalingReception(username, msg) {
        if (msg._jvrtc_ice !== undefined) {
            try {
                await this._peers.get(username).addIceCandidate(msg._jvrtc_ice);
            } catch (e) {
                console.log("<jv-session-rtc> error with ice candidate, discarded");
            }
        }
    }

    async _onSignalingJoin(username) {
        this._streamsPerUser[username] = new Set();
        this._initPeer(username, false); // is_initiator = false
    }

    async _onSignalingLeave(username) {
        this._peers.delete(username);
        for (let stream of this._streamsPerUser[username].values()) {
            this.onStreamEnd(username, this._streams[stream]);
            delete this._streams[stream];
        }
        delete this._streamsPerUser[username];
    }

    async _onSignalingRequest(username, msg) {
        if (msg._jvrtc_description) {
            // implementing perfect negotiation pattern to avoid collisions of negotiations
            // https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
            const peerConnection = this._peers.get(username);
            const collision = peerConnection.jvrtc_makingOffer || peerConnection.signalingState != "stable";
            if (collision && !peerConnection.jvrtc_polite) {
                // we are impolite, we discard the received offer.
                return null;
            } else {
                // we are polite or there is no collision: we accept the received offer.
                await peerConnection.setRemoteDescription(msg._jvrtc_description);
                await peerConnection.setLocalDescription();
                
                return peerConnection.localDescription;
            }
        } else {
            return "UNHANDLED";
        }
    }

    async _makeNegotiation(username, peerConnection) {
        peerConnection.jvrtc_makingOffer = true;
        try {
            await peerConnection.setLocalDescription();
            const response = await this._signaler.ask(username, {_jvrtc_description: peerConnection.localDescription});
            if (response !== null) // may be null if peer is impolite (in case of offer collisions)
                peerConnection.setRemoteDescription(response);
        } finally {
            peerConnection.jvrtc_makingOffer = false;
        }
    }
}
