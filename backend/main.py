#!/usr/bin/env python3
"""By Julien Vernay ( jvernay.fr ). Under GNU AGPL v3."""
import base64
import random
import logging
import json
import argparse
import asyncio
import sys
import traceback
from typing import Optional
from dataclasses import dataclass

import websockets


class SessionException(Exception):
    """Base exception for 'normal' exceptions which will be transmitted to the client."""
    pass

class Session:
    """Encapsulates a group of connections which can talk with each other using usernames."""

    class IdNotFound(SessionException): pass
    class InvalidPassword(SessionException): pass
    class InvalidUsername(SessionException): pass
    class AlreadyConnected(SessionException): pass
    class NotConnected(SessionException): pass


    def getDisplayID(self):
        """Returns the session ID as a readable string (hex string of 6 characters)."""
        return base64.b16encode(self._id.to_bytes(3, "little")).decode("ascii")
    

    def getState(self):
        """Returns a description of the state, suitable for serializing with JSON."""
        return {
            "id": self.getDisplayID(),
            "users": list(self._connections.keys()),
        }
    

    def __init__(self, appname, password):
        """Creates a Session with the given password.
        Raises Session.IdNotFound if we could not allocate an ID for the Session."""
        if not appname in Session._all:
            Session._all[appname] = {}
        self._appname = appname
        self._id = Session._allocateID(appname)
        self._connections = {}
        self._password = password
        Session._all[appname][self._id] = self
        logging.info(f"Creation of session #{self.getDisplayID()}.")
    

    async def join(self, websocket, username):
        """Returns a connection linking this session and this user.
        Raises Session.AlreadyConnected if the username is already taken."""

        if not 0 < len(username) < 30:
            raise Session.InvalidUsername(f"The username cannot be empty nor too big.")

        if username in self._connections:
            raise Session.InvalidUsername(f"{username} is already connected to session #{self.getDisplayID()}.")
        
        connection = Connection(websocket, self, username)
        self._connections[username] = connection
        logging.info(f"{username} has joined session #{self.getDisplayID()}.")

        message_json = json.dumps({
            "joined": username, "users": list(self._connections.keys())
        })

        tasks = [asyncio.create_task(con.websocket.send(message_json))
                 for user, con in self._connections.items() if user != username]
        if tasks:
            await asyncio.wait(tasks)

        return connection

    async def send(self, user, message):
        """Sends a message to a user, converted as JSON.
        If 'user' is None, the message is sent to all users.
        Raises Session.InvalidUsername if 'user' is not a username of this session."""

        message_json = json.dumps(message)
        logging.info(f"Message sent to {user}: {message_json}")

        if user is None:
            await asyncio.wait([asyncio.create_task(con.websocket.send(message_json))
                                for _, con in self._connections.items()])
        elif user in self._connections:
            await self._connections[user].websocket.send(message_json)
        else:
            raise Session.InvalidUsername(f"Unkown user '{user}'.")
            

    @staticmethod
    async def joinSession(displayID, websocket, appname, username, password):
        """Returns a connection linked to the session attributed with displayID.
        Raises Session.IdNotFound if the ID is not allocated.
        Raises Session.InvalidPassword if the password does not match.
        Raises Session.AlreadyConnected if the username is already taken."""
        try:
            id = int.from_bytes(base64.b16decode(displayID), "little")
        except:
            raise Session.IdNotFound(f"Bad format of session ID: {displayID}.")
        if not appname in Session._all:
            raise Session.IdNotFound(f"Could not find session for app {appname}.")
        appsessions = Session._all[appname]
        if not id in appsessions:
            raise Session.IdNotFound(f"Could not find session #{displayID}.")
        session = appsessions[id]
        if session._password != password:
            raise Session.InvalidPassword(f"Invalid password.")
        
        return await session.join(websocket, username)
    

    async def leave(self, username):
        """Removes given user from the session."""
        self._connections.pop(username)
        logging.info(f"{username} has left session #{self.getDisplayID()}.")
        if not self._connections: # if empty
            self.delete()
        else:
            await self.send(None, {
                "left": username, "users": list(self._connections.keys())
            })

    def delete(self):
        Session._all[self._appname].pop(self._id) # remove itself from sessions
        logging.info(f"Session #{self.getDisplayID()} is empty, and removed.")

    
    _all = {}

    @staticmethod
    def _allocateID(appname) -> int:
        """Returns a random non-allocated ID as integer (< 2^24).
        Raises Session.IdNotFound if too many tries have been done without success."""
        appsessions = Session._all[appname]
        for _ in range(20): # maximum 20 tries
            id = random.getrandbits(24)
            if not id in appsessions:
                # non-allocated ID found
                return id
        # non-allocated ID not found, too many tries have been done.
        raise Session.IdNotFound("Could not find a non-allocated ID for a new session.")
    
@dataclass
class Connection:
    """Represents the fact that a user is currently connected to a session."""
    websocket: websockets.WebSocketServerProtocol
    session: Session
    username: str

    def __str__(self):
        return f"Connection(#{self.session.getDisplayID()}, {self.username})"


async def handleWebsocket(websocket, path=None):
    """Handles connection from a Websocket. Can be passed to websockets.serve(...)."""
    # 'path' is unused.

    connection : Optional[Connection] = None

    try:
        async for message in websocket:
            request = None
            try:
                request = json.loads(message)
                action = request["action"]

                if action == "create":
                    if connection:
                        raise Session.AlreadyConnected(f"Already connected to session #{connection.session.getDisplayID()} as {connection.username}.")
                    password = request["password"]
                    username = request["username"]
                    appname = request["appname"]
                    session = Session(appname, password)
                    try: # may throw if invalid username
                        connection = await session.join(websocket, username)
                    except:
                        session.delete()
                        raise

                    await websocket.send(json.dumps(connection.session.getState()))

                elif action == "join":
                    if connection:
                        raise Session.AlreadyConnected(f"Already connected to session #{connection.session.getDisplayID()} as {connection.username}.")
                    displayID = request["id"]
                    username = request["username"]
                    password = request["password"]
                    appname = request["appname"]
                    connection = await Session.joinSession(displayID, websocket, appname, username, password)
                    await websocket.send(json.dumps(connection.session.getState()))
                
                elif action == "send":
                    if not connection:
                        raise Session.NotConnected(f"Not connected to any session.")
                    user = request["user"]
                    message = request["message"]

                    try: await connection.session.send(user, {"from": connection.username, "message": message})
                    except Session.InvalidUsername: pass # discard message if username not found

                elif action == "request" or action == "response":
                    logging.info(message)
                    if not connection:
                        raise Session.NotConnected(f"Not connected to any session.")
                    user = request["user"]
                    message = request["message"]
                    id = request["id"]
                    if user is None:
                        raise Session.InvalidUsername("Cannot broadcast a request.")
                    # only forwarding requests and responses.
                    await connection.session.send(user, {"from": connection.username, action: message, "id": id})

                elif action == "leave":
                    if not connection:
                        raise Session.NotConnected(f"Not connected to any session.")
                    await connection.session.leave(connection.username)
                    connection = None
                
                else:
                    raise SessionException(f"Unkown action '{action}'.")
                    
                
            except (SessionException, KeyError, json.JSONDecodeError):
                exc_info = sys.exc_info()
                await websocket.send(json.dumps({
                    "error": f"{exc_info[0].__name__}: {exc_info[1]}",
                    "id": request["id"] if (request and "id" in request) else None,
                }))
            except:
                logging.exception(f"Unknown error with connection = {connection}")
    except websockets.exceptions.ConnectionClosedError:
        pass
    except:
        logging.exception(f"Unknown FATAL error with connection = {connection}")
    finally:
        if connection:
            await connection.session.leave(connection.username)
            connection = None


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARN)

    start_server = websockets.serve(handleWebsocket, "localhost", 1234)

    asyncio.get_event_loop().run_until_complete(start_server)
    asyncio.get_event_loop().run_forever()
