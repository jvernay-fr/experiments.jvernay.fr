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
    
    // Returns the list of usernames, ordered chronologically by arrivals.
    getUsers() {
        return this._peers.keys();
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
    // 'reply' is a function to be called to give the response to the request.
    // 'reply(answer)' must be called, else the requesting user will be awaiting forever.
    async onRequest(from, msg, reply) { reply(`REQUEST NOT HANDLED: ${msg}`); }

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

        for (let username of this._signaler.getUsers()) {
            if (username === this.username) continue;

            waitingPromises.push(new Promise((resolve, reject) => {
                this._waitingDataChannels.set(username, [resolve, reject]);

                const peerConnection = this._initPeer(username, true); // is_initiator = true
                const dataChannel = peerConnection.createDataChannel("_jvrtc");
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

        return peerConnection;
    }

    _initDataChannel(username, channel) {
        this._peers.get(username).jvrtc_datachannel = channel;
        channel.onopen = () => this._onDataChannelOpen(username);
        channel.onmessage = event => this._onDataChannelMessage(username, channel, event);
        channel.onclose = () => this._onDataChannelClose(username);
        channel.onerror = event => this._onDataChannelError(event, username);
    }

    async _onDataChannelOpen(username) {
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
    }


    async _onSignalingReception(username, msg) {
        if (msg._jvrtc_ice !== undefined) {
            await this._peers.get(username).addIceCandidate(msg._jvrtc_ice);
        }
    }

    async _onSignalingJoin(username) {
        this._initPeer(username, false); // is_initiator = false
    }

    async _onSignalingLeave(username) {
        this._peers.delete(username);
    }

    async _onSignalingRequest(username, msg, reply) {
        if (msg._jvrtc_description) {
            // implementing perfect negotiation pattern to avoid collisions of negotiations
            // https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
            const peerConnection = this._peers.get(username);
            const collision = peerConnection.jvrtc_makingOffer || peerConnection.signalingState != "stable";
            if (collision && !peerConnection.jvrtc_polite) {
                // we are impolite, we discard the received offer.
                reply(null);
            } else {
                // we are polite or there is no collision: we accept the received offer.
                await peerConnection.setRemoteDescription(msg._jvrtc_description);
                await peerConnection.setLocalDescription();
                
                reply(peerConnection.localDescription);
            }
        } else {
            reply("UNHANDLED");
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
