// ==UserScript==
// @name         Maxlow Player Cam
// @namespace    maxlow-designs
// @version      0.9.18
// @description  Maxlow Player Cam: player cam + board cam + live audio + peer-to-peer chat
// @match        https://play.autodarts.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    
    const maxlowPinBroadcastCss = '\n/* ===== MAXLOW v0.8.2 — PIN INPUT BROADCAST STYLE ===== */\n#maxlow-pin-input-button,\n#maxlow-pin-input-btn,\nbutton[data-maxlow-pin-input],\n.maxlow-pin-input-button {\n    background: linear-gradient(90deg, #1558b0 0 50%, #d71920 50% 100%) !important;\n    color: #fff !important;\n    border: 1px solid rgba(255,255,255,.65) !important;\n    border-radius: 3px !important;\n    box-shadow: 0 0 10px rgba(34,137,255,.35), 0 0 10px rgba(255,45,45,.25) !important;\n    font-weight: 900 !important;\n    letter-spacing: .4px !important;\n}\n\n/* Sender / PIN panel: dark broadcast card with Maxlow blue/red trim */\n#maxlow-sender-overlay,\n#maxlow-pin-overlay,\n.maxlow-sender-overlay,\n.maxlow-pin-overlay {\n    background: rgba(6,10,18,.97) !important;\n    border: 1px solid #2388ff !important;\n    border-radius: 7px !important;\n    box-shadow: 0 0 0 1px rgba(230,30,35,.55), 0 0 20px rgba(0,0,0,.7) !important;\n}\n\n/* Any obvious PIN heading inside the sender panel */\n#maxlow-sender-overlay h1,\n#maxlow-sender-overlay h2,\n#maxlow-sender-overlay h3,\n#maxlow-pin-overlay h1,\n#maxlow-pin-overlay h2,\n#maxlow-pin-overlay h3 {\n    color: #fff !important;\n    text-transform: uppercase !important;\n    letter-spacing: .7px !important;\n}\n\n/* Reusable Maxlow Designs badge used by the script */\n.maxlow-pin-brand {\n    display:flex;\n    align-items:center;\n    width:max-content;\n    overflow:hidden;\n    border-radius:2px;\n    font-family:Arial,Helvetica,sans-serif;\n    font-size:12px;\n    line-height:20px;\n    font-weight:900;\n    color:#fff;\n    box-shadow:0 0 8px rgba(0,0,0,.5);\n}\n.maxlow-pin-brand .maxlow-blue { background:#1558b0; padding:0 7px; }\n.maxlow-pin-brand .maxlow-red  { background:#d71920; padding:0 7px; }\n';
    try {
        if (typeof GM_addStyle === 'function') GM_addStyle(maxlowPinBroadcastCss);
        else {
            const s = document.createElement('style');
            s.textContent = maxlowPinBroadcastCss;
            document.documentElement.appendChild(s);
        }
    } catch (e) { console.warn('MAXLOW: PIN style injection failed', e); }
const CAMERA_ID = 'maxlow-live-player-cam';
    const WRAPPER_ID = 'maxlow-live-player-cam-wrapper';
    const BUTTON_ID = 'maxlow-live-cam-button';
    const SETTINGS_ID = 'maxlow-live-cam-settings-button';
    const PANEL_ID = 'maxlow-live-cam-panel';
    const BOARD_CAMERA_ID = 'maxlow-live-board-cam';
    const BOARD_WRAPPER_ID = 'maxlow-live-board-cam-wrapper';

    let cameraStream = null;
    let boardCameraStream = null;
    let cameraEnabled = true;

    // ONLINE MODE - public Maxlow signalling server
    const SIGNAL_URL = 'wss://maxlow-player-cam-server.onrender.com/ws';
    let onlineSocket = null;
    let onlinePeer = null;
    let remoteStream = null;
    let remoteBoardStream = null;
    let remoteVideoTrackCount = 0;
    let microphoneStream = null;
    let remoteAudioStream = null;
    let onlineChatChannel = null;
    const maxlowChatHistory = [];
    let endedMatchId = '';
    let pendingIce = [];
    let onlineIdentity = null;
    let onlinePairingPin = '';
    let onlineCameraPeerId = '';
    let lastTurnState = null;
    let onlineReconnectTimer = null;
    let peerRecoveryTimer = null;
    let intentionalOnlineStop = false;

    const defaults = {
        deviceId: '',
        boardCameraEnabled: false,
        boardDeviceId: '',
        audioEnabled: false,
        audioDeviceId: '',
        size: 'medium',
        position: 'bottom-right',
        mode: 'local'
    };

    let settings = loadSettings();

    function loadSettings() {
        try {
            return {
                ...defaults,
                ...JSON.parse(
                    localStorage.getItem('maxlow-player-cam-settings') || '{}'
                )
            };
        } catch {
            return { ...defaults };
        }
    }

    function saveSettings() {
        localStorage.setItem(
            'maxlow-player-cam-settings',
            JSON.stringify(settings)
        );
    }

    // ============================================================
    // MAXLOW LIVE CHAT
    // ============================================================
    function setChatChannel(channel) {
        onlineChatChannel = channel || null;
        window.__maxlowChatChannel = channel || null;
        if (!channel) return;

        channel.onopen = () => {
            console.log('MAXLOW: CHAT CONNECTED');
            const s = document.getElementById('maxlow-chat-status');
            if (s) s.textContent = 'LIVE';
        };
        channel.onclose = () => {
            const s = document.getElementById('maxlow-chat-status');
            if (s) s.textContent = 'OFFLINE';
        };
        channel.onmessage = event => {
            const packet = parseMaxlowChatPacket(String(event.data || ''));
            addChatMessage(packet.message, false, packet.username);
        };
    }


    function getMaxlowChatUsername() {
        try {
            const state = findMatchState?.();
            const userId = state?.userId;

            const players =
                state?.gameClient?.players ||
                state?.players ||
                [];

            const list = Array.isArray(players)
                ? players
                : Object.values(players || {});

            const me = list.find(player =>
                String(
                    player?.userId ??
                    player?.id ??
                    player?.uid ??
                    ''
                ) === String(userId ?? '')
            );

            return String(
                me?.username ??
                me?.userName ??
                me?.name ??
                me?.displayName ??
                me?.nickname ??
                userId ??
                'PLAYER'
            ).trim();
        } catch {
            return 'PLAYER';
        }
    }

    function parseMaxlowChatPacket(raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed?.type === 'maxlow-chat' && typeof parsed.message === 'string') {
                return {
                    username: String(parsed.username || 'PLAYER'),
                    message: parsed.message
                };
            }
        } catch {}
        return { username: 'PLAYER', message: String(raw || '') };
    }

    function renderChatMessage(message, mine, username = 'PLAYER') {
        const list = document.getElementById('maxlow-chat-messages');
        if (!list) return;
        const row = document.createElement('div');
        row.style.cssText = `margin:6px 0;padding:8px 10px;border-radius:4px;max-width:85%;word-break:break-word;
            ${mine ? 'margin-left:auto;background:#1558b0;' : 'margin-right:auto;background:#202938;'}`;
        row.textContent = `${username}: ${message}`;
        list.appendChild(row);
        list.scrollTop = list.scrollHeight;
    }

    function addChatMessage(message, mine, username = 'PLAYER') {
        if (!message) return;

        maxlowChatHistory.push({ message, mine: !!mine, username });
        if (maxlowChatHistory.length > 100) maxlowChatHistory.shift();

        const list = document.getElementById('maxlow-chat-messages');
        if (list) {
            renderChatMessage(message, mine, username);
        } else if (!mine) {
            const btn = document.getElementById('maxlow-chat-button');
            if (btn) {
                const count = Number(btn.dataset.unread || 0) + 1;
                btn.dataset.unread = String(count);
                btn.textContent = `CHAT • ${count}`;
            }
        }
    }

    window.maxlowSetChatChannel = setChatChannel;
    window.maxlowChatReceive = raw => {
        const packet = parseMaxlowChatPacket(String(raw || ''));
        addChatMessage(packet.message, false, packet.username);
    };

    window.maxlowOpenChat = function () {
        let panel = document.getElementById('maxlow-chat-panel');
        if (panel) {
            panel.remove();
            return;
        }

        const btn = document.getElementById('maxlow-chat-button');
        if (btn) {
            btn.dataset.unread = '0';
            btn.textContent = 'CHAT';
        }

        panel = document.createElement('div');
        panel.id = 'maxlow-chat-panel';
        panel.style.cssText = 'position:fixed;right:12px;top:52px;width:min(92vw,360px);height:430px;z-index:2147483646;background:#070b12;color:#fff;border:1px solid #2388ff;box-shadow:0 0 0 1px rgba(215,25,32,.65),0 12px 40px rgba(0,0,0,.7);font-family:Arial,sans-serif;padding:12px;border-radius:5px;display:flex;flex-direction:column;';

        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
                <div style="display:flex;font-weight:900">
                    <span style="background:#1558b0;padding:4px 8px">Maxlow</span>
                    <span style="background:#d71920;padding:4px 8px">Designs</span>
                </div>
                <div id="maxlow-chat-status" style="font-size:10px;color:#9fb4cc;font-weight:900">${window.__maxlowChatChannel?.readyState === 'open' ? 'LIVE' : 'OFFLINE'}</div>
            </div>
            <div style="font-size:11px;font-weight:900;letter-spacing:1.4px;margin-bottom:8px">PLAYER CHAT</div>
            <div id="maxlow-chat-messages" style="flex:1;overflow:auto;background:#02050a;border:1px solid #223247;padding:8px;border-radius:3px"></div>
            <div style="display:flex;gap:6px;margin-top:8px">
                <input id="maxlow-chat-input" maxlength="300" placeholder="Type a message..." style="flex:1;background:#030712;color:#fff;border:1px solid #315b87;border-radius:3px;padding:10px;outline:none">
                <button id="maxlow-chat-send" style="background:#d71920;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:3px;padding:0 14px;font-weight:900;cursor:pointer">SEND</button>
            </div>`;

        document.body.appendChild(panel);

        // Repaint messages received/sent earlier in this match/session.
        maxlowChatHistory.forEach(item => renderChatMessage(item.message, item.mine, item.username));

        const input = document.getElementById('maxlow-chat-input');
        const sendButton = document.getElementById('maxlow-chat-send');

        const sendMessage = () => {
            const message = input.value.trim();
            const channel = window.__maxlowChatChannel;
            if (!message || !channel || channel.readyState !== 'open') return;
            const username = getMaxlowChatUsername();
            channel.send(JSON.stringify({
                type: 'maxlow-chat',
                username,
                message
            }));
            addChatMessage(message, true, username);
            input.value = '';
            input.focus();
        };
        sendButton.onclick = sendMessage;
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') sendMessage();
        });
        input.focus();
    };


    // ============================================================
    // CREATE CAMERA + BROADCAST FRAME
    // ============================================================

    function createCamera() {

        let wrapper = document.getElementById(WRAPPER_ID);

        if (wrapper) {
            return document.getElementById(CAMERA_ID);
        }

        wrapper = document.createElement('div');
        wrapper.id = WRAPPER_ID;

        Object.assign(wrapper.style, {
            position: 'fixed',
            zIndex: '999999',
            boxSizing: 'border-box',
            fontFamily: 'Arial, Helvetica, sans-serif',
            overflow: 'visible'
        });


        // ========================================================
        // UNIFIED CAMERA VIEWPORT
        // ========================================================

        const viewport = document.createElement('div');

        Object.assign(viewport.style, {
            position: 'absolute',

            left: '3%',
            right: '3%',
            top: '12%',
            bottom: '6%',

            background: '#000',

            borderLeft: '4px solid #ff1717',
            borderRight: '4px solid #168cff',

            borderRadius: '0 0 7px 7px',

            boxSizing: 'border-box',
            overflow: 'hidden',

            zIndex: '1',

            boxShadow:
                '-3px 0 10px rgba(255,23,23,.75), ' +
                '3px 0 10px rgba(22,140,255,.75)'
        });


        // ========================================================
        // CAMERA
        // ========================================================

        const video = document.createElement('video');

        video.id = CAMERA_ID;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;

        Object.assign(video.style, {
            position: 'absolute',

            inset: '0',

            width: '100%',
            height: '100%',

            objectFit: 'cover',

            display: 'block',

            margin: '0',
            padding: '0',

            border: '0',
            outline: '0',

            background: '#000',

            zIndex: '1'
        });

        viewport.appendChild(video);


        // ========================================================
        // TOP RED / BLUE BORDER
        // ========================================================

        const topBorder = document.createElement('div');

        Object.assign(topBorder.style, {
            position: 'absolute',

            left: '0',
            right: '0',
            top: '0',

            height: '3px',

            background:
                'linear-gradient(90deg,' +
                '#ff1717 0%,' +
                '#ff1717 48%,' +
                '#168cff 52%,' +
                '#168cff 100%)',

            zIndex: '3'
        });

        viewport.appendChild(topBorder);


        // ========================================================
        // BOTTOM RED / BLUE BORDER
        // ========================================================

        const bottomBorder = document.createElement('div');

        Object.assign(bottomBorder.style, {
            position: 'absolute',

            left: '0',
            right: '0',
            bottom: '0',

            height: '3px',

            background:
                'linear-gradient(90deg,' +
                '#ff1717 0%,' +
                '#ff1717 48%,' +
                '#168cff 52%,' +
                '#168cff 100%)',

            zIndex: '3'
        });

        viewport.appendChild(bottomBorder);

        wrapper.appendChild(viewport);


        // ========================================================
        // BROADCAST OVERLAY
        // ========================================================

        const frame = document.createElement('div');

        Object.assign(frame.style, {
            position: 'absolute',
            inset: '0',
            zIndex: '5',
            pointerEvents: 'none'
        });


        frame.innerHTML = `

            <!-- ==================================================
                 STRAIGHT TOP BROADCAST BAR
            =================================================== -->

            <div style="
                position:absolute;

                left:3%;
                right:3%;
                top:0;

                height:13%;

                background:
                    linear-gradient(
                        180deg,
                        #20242b 0%,
                        #07090d 45%,
                        #11151b 100%
                    );

                border-top:2px solid #9ca5af;
                border-bottom:2px solid #222;

                border-left:1px solid #363b43;
                border-right:1px solid #363b43;

                border-radius:0;

                box-sizing:border-box;

                box-shadow:
                    0 4px 12px rgba(0,0,0,.8);

                z-index:5;
            "></div>


            <!-- ==================================================
                 MAXLOW DESIGNS
            =================================================== -->

            <div style="
                position:absolute;

                top:1.5%;
                left:50%;

                transform:translateX(-50%);

                display:flex;

                height:9%;
                min-height:22px;

                border:
                    1px solid rgba(255,255,255,.55);

                border-radius:4px;

                overflow:hidden;

                box-shadow:
                    0 2px 8px rgba(0,0,0,.7);

                font-family:
                    Arial, Helvetica, sans-serif;

                font-weight:700;

                font-size:
                    clamp(11px,2.2vw,28px);

                line-height:1;

                white-space:nowrap;

                z-index:10;
            ">

                <div style="
                    display:flex;
                    align-items:center;

                    padding:0 .5em;

                    color:#fff;

                    background:
                        linear-gradient(
                            180deg,
                            #1f59ae,
                            #092a6c
                        );
                ">
                    Maxlow
                </div>


                <div style="
                    display:flex;
                    align-items:center;

                    padding:0 .5em;

                    color:#fff;

                    background:
                        linear-gradient(
                            180deg,
                            #ff2c2c,
                            #b50000
                        );
                ">
                    Designs
                </div>

            </div>


            <!-- ==================================================
                 LIVE LEFT
            =================================================== -->

            <div style="
                position:absolute;

                left:5%;
                top:3%;

                display:flex;
                align-items:center;

                gap:5px;

                color:#fff;

                font-weight:900;
                font-style:italic;

                font-size:
                    clamp(7px,1.2vw,16px);

                text-shadow:
                    0 1px 3px #000;

                z-index:10;
            ">

                <span style="
                    display:inline-block;

                    width:.7em;
                    height:.7em;

                    border-radius:50%;

                    background:#ff1010;

                    box-shadow:
                        0 0 8px #ff0000;
                "></span>

                LIVE

            </div>


            <!-- ==================================================
                 LIVE RIGHT
            =================================================== -->

            <div style="
                position:absolute;

                right:5%;
                top:3%;

                display:flex;
                align-items:center;

                gap:5px;

                color:#fff;

                font-weight:900;
                font-style:italic;

                font-size:
                    clamp(7px,1.2vw,16px);

                text-shadow:
                    0 1px 3px #000;

                z-index:10;
            ">

                LIVE

                <span style="
                    display:inline-block;

                    width:.7em;
                    height:.7em;

                    border-radius:50%;

                    background:#ff1010;

                    box-shadow:
                        0 0 8px #ff0000;
                "></span>

            </div>


            <!-- ==================================================
                 OCHE CAMERA BOTTOM BADGE
            =================================================== -->

            <div style="
                position:absolute;

                left:35%;
                right:35%;

                bottom:2%;

                height:8%;
                min-height:18px;

                background:
                    linear-gradient(
                        180deg,
                        #15191f,
                        #050609
                    );

                border:
                    2px solid #69717a;

                clip-path:
                    polygon(
                        7% 0,
                        93% 0,
                        100% 50%,
                        93% 100%,
                        7% 100%,
                        0 50%
                    );

                display:flex;

                justify-content:center;
                align-items:center;

                color:#fff;

                font-size:
                    clamp(6px,1.1vw,14px);

                font-weight:700;

                letter-spacing:.35em;

                text-shadow:
                    0 1px 3px #000;

                z-index:10;
            ">

                BOARD CAMERA

            </div>


            <!-- RED BOTTOM ACCENT -->


            <!-- BLUE BOTTOM ACCENT -->

        `;

        wrapper.appendChild(frame);

        document.body.appendChild(wrapper);

        return video;
    }



    // ============================================================
    // BOARD CAMERA (picture-in-picture)
    // ============================================================

    function createBoardCamera() {
        let boardWrapper = document.getElementById(BOARD_WRAPPER_ID);
        if (boardWrapper) return document.getElementById(BOARD_CAMERA_ID);

        boardWrapper = document.createElement('div');
        boardWrapper.id = BOARD_WRAPPER_ID;
        Object.assign(boardWrapper.style, {
            position: 'fixed',
            zIndex: '999998',
            boxSizing: 'border-box',
            fontFamily: 'Arial, Helvetica, sans-serif',
            overflow: 'visible',
            display: 'none'
        });

        const viewport = document.createElement('div');
        Object.assign(viewport.style, {
            position: 'absolute', left: '3%', right: '3%', top: '12%', bottom: '6%',
            background: '#000', borderLeft: '4px solid #ff1717', borderRight: '4px solid #168cff',
            borderRadius: '0 0 7px 7px', boxSizing: 'border-box', overflow: 'hidden', zIndex: '1',
            boxShadow: '-3px 0 10px rgba(255,23,23,.75), 3px 0 10px rgba(22,140,255,.75)'
        });

        const video = document.createElement('video');
        video.id = BOARD_CAMERA_ID;
        video.autoplay = true; video.muted = true; video.playsInline = true;
        Object.assign(video.style, {
            position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover',
            display: 'block', margin: '0', padding: '0', border: '0', outline: '0', background: '#000', zIndex: '1'
        });
        viewport.appendChild(video);

        const topBorder = document.createElement('div');
        Object.assign(topBorder.style, {position:'absolute',left:'0',right:'0',top:'0',height:'3px',background:'linear-gradient(90deg,#ff1717 0%,#ff1717 48%,#168cff 52%,#168cff 100%)',zIndex:'3'});
        const bottomBorder = document.createElement('div');
        Object.assign(bottomBorder.style, {position:'absolute',left:'0',right:'0',bottom:'0',height:'3px',background:'linear-gradient(90deg,#ff1717 0%,#ff1717 48%,#168cff 52%,#168cff 100%)',zIndex:'3'});
        viewport.append(topBorder,bottomBorder);
        boardWrapper.appendChild(viewport);

        const frame = document.createElement('div');
        Object.assign(frame.style,{position:'absolute',inset:'0',zIndex:'5',pointerEvents:'none'});
        frame.innerHTML = `
            <div style="
                position:absolute;left:3%;right:3%;top:0;height:13%;
                background:linear-gradient(180deg,#20242b 0%,#07090d 45%,#11151b 100%);
                border-top:2px solid #9ca5af;border-bottom:2px solid #222;
                border-left:1px solid #363b43;border-right:1px solid #363b43;
                border-radius:0;box-sizing:border-box;box-shadow:0 4px 12px rgba(0,0,0,.8);z-index:5;
            "></div>

            <div style="
                position:absolute;top:1.5%;left:50%;transform:translateX(-50%);
                display:flex;height:9%;min-height:22px;
                border:1px solid rgba(255,255,255,.55);border-radius:4px;overflow:hidden;
                box-shadow:0 2px 8px rgba(0,0,0,.7);
                font-family:Arial,Helvetica,sans-serif;font-weight:700;
                font-size:clamp(11px,2.2vw,28px);line-height:1;white-space:nowrap;z-index:10;
            ">
                <div style="display:flex;align-items:center;padding:0 .5em;color:#fff;background:linear-gradient(180deg,#1f59ae,#092a6c);">Maxlow</div>
                <div style="display:flex;align-items:center;padding:0 .5em;color:#fff;background:linear-gradient(180deg,#ff2c2c,#b50000);">Designs</div>
            </div>

            <div style="position:absolute;left:5%;top:3%;display:flex;align-items:center;gap:5px;color:#fff;font-weight:900;font-style:italic;font-size:clamp(7px,1.2vw,16px);text-shadow:0 1px 3px #000;z-index:10;">
                <span style="display:inline-block;width:.7em;height:.7em;border-radius:50%;background:#ff1010;box-shadow:0 0 8px #ff0000;"></span> LIVE
            </div>

            <div style="position:absolute;right:5%;top:3%;display:flex;align-items:center;gap:5px;color:#fff;font-weight:900;font-style:italic;font-size:clamp(7px,1.2vw,16px);text-shadow:0 1px 3px #000;z-index:10;">
                LIVE <span style="display:inline-block;width:.7em;height:.7em;border-radius:50%;background:#ff1010;box-shadow:0 0 8px #ff0000;"></span>
            </div>

            <div style="
                position:absolute;left:35%;right:35%;bottom:2%;height:8%;min-height:18px;
                background:linear-gradient(180deg,#15191f,#050609);
                border:1px solid #69717a;
                clip-path:polygon(7% 0,93% 0,100% 50%,93% 100%,7% 100%,0 50%);
                display:flex;justify-content:center;align-items:center;color:#fff;
                font-size:clamp(6px,1.1vw,14px);font-weight:700;letter-spacing:.22em;
                text-shadow:0 1px 3px #000;z-index:10;
            ">OCHE CAMERA</div>
        `;
        boardWrapper.appendChild(frame);
        document.body.appendChild(boardWrapper);
        applyBoardCameraLayout();
        return video;
    }

    function applyBoardCameraLayout() {
        const boardWrapper = document.getElementById(BOARD_WRAPPER_ID);
        if (!boardWrapper) return;
        const sizes = {small:['480px','250px'],medium:['720px','375px'],large:['960px','500px']};
        const [width,height] = sizes[settings.size] || sizes.medium;
        boardWrapper.style.width = width;
        boardWrapper.style.height = height;
        boardWrapper.style.top='auto'; boardWrapper.style.bottom='auto'; boardWrapper.style.left='auto'; boardWrapper.style.right='auto';

        // Oche cam mirrors the board cam to the opposite side of the screen.
        switch(settings.position) {
            case 'bottom-left': boardWrapper.style.right='25px'; boardWrapper.style.bottom='25px'; break;
            case 'bottom-right': boardWrapper.style.left='25px'; boardWrapper.style.bottom='25px'; break;
            case 'top-left': boardWrapper.style.right='25px'; boardWrapper.style.top='60px'; break;
            case 'top-right': boardWrapper.style.left='25px'; boardWrapper.style.top='60px'; break;
            default: boardWrapper.style.left='25px'; boardWrapper.style.bottom='25px';
        }
    }

    function showBoardVideo(stream) {
        const video = createBoardCamera();
        const boardWrapper = document.getElementById(BOARD_WRAPPER_ID);

        if (!stream || !boardWrapper) {
            if (boardWrapper) boardWrapper.style.display = 'none';
            if (video) video.srcObject = null;
            return;
        }

        if (video.srcObject !== stream) video.srcObject = stream;
        video.muted = true;
        boardWrapper.style.display = cameraEnabled ? 'block' : 'none';
        video.play().catch(() => {});
    }

    async function startBoardCamera() {
        if (!settings.boardCameraEnabled) {
            if (boardCameraStream) {
                boardCameraStream.getTracks().forEach(track => track.stop());
                boardCameraStream = null;
            }
            showBoardVideo(null);
            return;
        }

        try {
            if (boardCameraStream) {
                boardCameraStream.getTracks().forEach(track => track.stop());
                boardCameraStream = null;
            }

            const constraints = settings.boardDeviceId
                ? {
                    deviceId: { exact: settings.boardDeviceId },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
                : {
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                };

            boardCameraStream = await navigator.mediaDevices.getUserMedia({
                video: constraints,
                audio: false
            });

            if (settings.mode === 'local') showBoardVideo(boardCameraStream);
            console.log('MAXLOW: BOARD CAMERA READY');
        } catch (error) {
            console.error('MAXLOW: Board camera error', error);
            boardCameraStream = null;
            showBoardVideo(null);
        }
    }


    async function startMicrophone() {
        if (!settings.audioEnabled) {
            try { microphoneStream?.getTracks().forEach(t => t.stop()); } catch {}
            microphoneStream = null;
            return;
        }

        try {
            try { microphoneStream?.getTracks().forEach(t => t.stop()); } catch {}
            const audioConstraints = settings.audioDeviceId
                ? { deviceId: { exact: settings.audioDeviceId }, echoCancellation:true, noiseSuppression:true, autoGainControl:true }
                : { echoCancellation:true, noiseSuppression:true, autoGainControl:true };

            microphoneStream = await navigator.mediaDevices.getUserMedia({
                video:false,
                audio:audioConstraints
            });
            console.log('MAXLOW: MICROPHONE READY');
        } catch (error) {
            console.error('MAXLOW: Microphone error', error);
            microphoneStream = null;
        }
    }

    function playRemoteAudio(stream) {
        if (!stream) return;
        let audio = document.getElementById('maxlow-remote-audio');
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = 'maxlow-remote-audio';
            audio.autoplay = true;
            audio.playsInline = true;
            document.body.appendChild(audio);
        }
        audio.srcObject = stream;
        audio.volume = 1;
        audio.play().catch(() => console.warn('MAXLOW: click page once to allow opponent audio'));
    }

    // ============================================================
    // START CAMERA
    // ============================================================

    async function startCamera() {

        const video = createCamera();

        const wrapper =
            document.getElementById(WRAPPER_ID);

        applyCameraLayout();

        try {

            if (cameraStream) {

                cameraStream
                    .getTracks()
                    .forEach(track => track.stop());

                cameraStream = null;
            }


            const videoConstraints =
                settings.deviceId
                    ? {
                        deviceId: {
                            exact: settings.deviceId
                        },

                        width: {
                            ideal: 1280
                        },

                        height: {
                            ideal: 720
                        }
                    }
                    : {
                        width: {
                            ideal: 1280
                        },

                        height: {
                            ideal: 720
                        }
                    };


            cameraStream =
                await navigator.mediaDevices
                    .getUserMedia({
                        video: videoConstraints,
                        audio: false
                    });


            // LOCAL MODE: show our camera exactly as before.
            // ONLINE MODE: keep showing our own camera until an opponent
            // stream is actually available.
            if (settings.mode === 'local') {
                video.srcObject = cameraStream;
            } else {
                video.srcObject = remoteStream || cameraStream;
            }

            video.muted = true;
            wrapper.style.display = 'block';
            video.play().catch(() => {});

            cameraEnabled = true;

            updateCamButton();

            populateCameraList();

            if (settings.boardCameraEnabled && !boardCameraStream) {
                await startBoardCamera();
            }

            console.log(
                'MAXLOW UNIVERSAL PLAYER CAM v0.8.1'
            );

        } catch (error) {

            console.error(
                'MAXLOW LIVE CAMERA SYSTEM: Camera error',
                error
            );
        }
    }


    // ============================================================
    // CAMERA ON / OFF
    // ============================================================

    function hideCamera() {

        const wrapper =
            document.getElementById(WRAPPER_ID);

        if (wrapper) {
            wrapper.style.display = 'none';
        }

        cameraEnabled = false;

        updateCamButton();
    }


    function toggleCamera() {

        if (cameraEnabled) {
            hideCamera();
        } else {
            startCamera();
        }
    }


    // ============================================================
    // SIZE + POSITION
    // ============================================================

    function applyCameraLayout() {

        const wrapper =
            document.getElementById(WRAPPER_ID);

        if (!wrapper) return;


        const sizes = {

            small: [
                '480px',
                '250px'
            ],

            medium: [
                '720px',
                '375px'
            ],

            large: [
                '960px',
                '500px'
            ]

        };


        const [width, height] =
            sizes[settings.size] ||
            sizes.medium;


        wrapper.style.width = width;
        wrapper.style.height = height;

        // Keep optional board cam the same size, on the opposite side.
        if (document.getElementById(BOARD_WRAPPER_ID)) applyBoardCameraLayout();

        wrapper.style.top = 'auto';
        wrapper.style.bottom = 'auto';
        wrapper.style.left = 'auto';
        wrapper.style.right = 'auto';


        switch (settings.position) {

            case 'bottom-left':

                wrapper.style.left = '25px';
                wrapper.style.bottom = '25px';

                break;


            case 'top-left':

                wrapper.style.left = '25px';
                wrapper.style.top = '60px';

                break;


            case 'top-right':

                wrapper.style.right = '35px';
                wrapper.style.top = '60px';

                break;


            default:

                wrapper.style.right = '35px';
                wrapper.style.bottom = '25px';
        }
    }


    // ============================================================
    // TOOLBAR BUTTONS
    // ============================================================

    function updateCamButton() {

        const button =
            document.getElementById(BUTTON_ID);

        if (!button) return;


        button.textContent =
            cameraEnabled
                ? '📹 CAM ON'
                : '📹 CAM OFF';


        button.style.borderColor =
            cameraEnabled
                ? '#168cff'
                : '#e53935';
    }


    function styleToolbarButton(button) {

        Object.assign(button.style, {

            height: '30px',

            padding: '0 10px',

            marginLeft: '5px',

            border: '1px solid #168cff',

            borderRadius: '5px',

            background:
                'rgba(10,10,15,0.88)',

            color: '#fff',

            fontWeight: '700',

            fontSize: '11px',

            cursor: 'pointer',

            whiteSpace: 'nowrap'
        });
    }


    function createToolbarControls() {

        if (
            document.getElementById(BUTTON_ID) &&
            document.getElementById(SETTINGS_ID)
        ) {
            return;
        }


        const buttons =
            [...document.querySelectorAll('button')];


        const boardButton =
            buttons.find(button => {

                const text =
                    button.textContent
                        .trim()
                        .toLowerCase();

                return (
                    text === 'start' ||
                    text === 'stop'
                );
            });


        if (!boardButton) return;


        const toolbar =
            boardButton.parentElement;

        if (!toolbar) return;


        // CAMERA BUTTON

        if (!document.getElementById(BUTTON_ID)) {

            const camButton =
                document.createElement('button');

            camButton.id = BUTTON_ID;
            camButton.type = 'button';

            styleToolbarButton(camButton);

            camButton.addEventListener(
                'click',
                toggleCamera
            );

            toolbar.appendChild(camButton);

            updateCamButton();
        }


        // SETTINGS BUTTON

        if (!document.getElementById(SETTINGS_ID)) {

            const settingsButton =
                document.createElement('button');

            settingsButton.id = SETTINGS_ID;
            settingsButton.type = 'button';

            settingsButton.textContent = '⚙ MAXLOW';

            styleToolbarButton(settingsButton);

            settingsButton.title = 'Maxlow Camera Settings';
            settingsButton.style.padding = '0 10px';
            settingsButton.style.fontSize = '11px';
            settingsButton.style.fontWeight = '900';
            settingsButton.style.whiteSpace = 'nowrap';
            settingsButton.style.minWidth = '78px';


            settingsButton.addEventListener(
                'click',
                toggleSettingsPanel
            );


            toolbar.appendChild(
                settingsButton
            );
        }
    }


    // ============================================================
    // SETTINGS PANEL
    // ============================================================

    function toggleSettingsPanel() {

        const existing =
            document.getElementById(PANEL_ID);


        if (existing) {
            existing.remove();
            return;
        }


        createSettingsPanel();
    }


    function selectStyle() {

        return `
            width:100%;
            margin-top:5px;
            margin-bottom:14px;
            padding:8px;
            border-radius:6px;
            border:1px solid #444;
            background:#181b22;
            color:#fff;
        `;
    }


    function createSettingsPanel() {

        const panel =
            document.createElement('div');

        panel.id = PANEL_ID;


        Object.assign(panel.style, {

            position: 'fixed',

            top: '70px',

            right: '25px',

            width: '320px',

            zIndex: '1000000',

            background:
                'rgba(10,12,18,0.97)',

            border:
                '1px solid #168cff',

            borderRadius: '12px',

            padding: '18px',

            color: '#fff',

            fontFamily:
                'Arial, sans-serif',

            boxShadow:
                '0 10px 35px rgba(0,0,0,.65)'
        });


        panel.innerHTML = `

            <div style="
                display:flex;
                margin-bottom:5px;
                font-size:18px;
                font-weight:800;
            ">

                <span style="
                    background:#174a99;
                    padding:3px 7px;
                ">
                    Maxlow
                </span>

                <span style="
                    background:#d71920;
                    padding:3px 7px;
                ">
                    Designs
                </span>

            </div>


            <div style="
                color:#168cff;
                font-size:12px;
                font-weight:700;
                margin-bottom:18px;
            ">
                LIVE PLAYER CAM
            </div>


            <label style="font-size:12px;font-weight:800;">
                BOARD CAMERA
            </label>


            <select
                id="maxlow-camera-select"
                style="${selectStyle()}"
            >

                <option value="">
                    Default camera
                </option>

            </select>

            <label style="
                display:flex;align-items:center;gap:8px;
                font-size:12px;margin:2px 0 8px;
            ">
                <input id="maxlow-board-enabled" type="checkbox">
                OCHE CAMERA
            </label>

            <select
                id="maxlow-board-camera-select"
                style="${selectStyle()}"
            >
                <option value="">Default / second camera</option>
            </select>


            <label style="
                display:flex;align-items:center;gap:8px;
                font-size:12px;margin:2px 0 8px;
            ">
                <input id="maxlow-audio-enabled" type="checkbox">
                LIVE AUDIO
            </label>

            <select
                id="maxlow-audio-select"
                style="${selectStyle()}"
            >
                <option value="">Default microphone</option>
            </select>
<label style="font-size:12px;">
                SIZE
            </label>


            <select
                id="maxlow-size-select"
                style="${selectStyle()}"
            >

                <option value="small">
                    Small
                </option>

                <option value="medium">
                    Medium
                </option>

                <option value="large">
                    Large
                </option>

            </select>


            <label style="font-size:12px;">
                POSITION
            </label>


            <select
                id="maxlow-position-select"
                style="${selectStyle()}"
            >

                <option value="bottom-right">
                    Bottom Right
                </option>

                <option value="bottom-left">
                    Bottom Left
                </option>

                <option value="top-right">
                    Top Right
                </option>

                <option value="top-left">
                    Top Left
                </option>

            </select>


            <label style="font-size:12px;">
                MODE
            </label>


            <select
                id="maxlow-mode-select"
                style="${selectStyle()}"
            >

                <option value="local">
                    Local Player Cam
                </option>

                <option value="online">
                    Online Player Cam
                </option>

            </select>


            <div style="
                margin-top:14px;padding:12px;border:1px solid #2d8cff;
                border-radius:8px;background:#0b1422;text-align:center;">
                <div style="font-size:10px;color:#9aa8bc;letter-spacing:1px;margin-bottom:5px;">
                    ONLINE CAMERA PAIRING PIN
                </div>
                <div id="maxlow-online-pin" style="
                    font-size:26px;line-height:1;font-weight:900;
                    letter-spacing:5px;color:#fff;">------</div>
                <div style="font-size:10px;color:#8d99aa;margin-top:7px;">
                    Enter this PIN on the Maxlow Camera Sender
                </div>
            </div>

            <div style="
                margin-top:15px;
                padding-top:12px;
                border-top:1px solid #333;
                font-size:10px;
                color:#888;
                text-align:center;
            ">
                MAXLOW DESIGNS AUTODARTS
            </div>

        `;


        document.body.appendChild(panel);


        const cameraSelect =
            document.getElementById('maxlow-camera-select');

        const boardEnabled =
            document.getElementById('maxlow-board-enabled');

        const boardSelect =
            document.getElementById('maxlow-board-camera-select');

        const audioEnabled =
            document.getElementById('maxlow-audio-enabled');

        const audioSelect =
            document.getElementById('maxlow-audio-select');
const sizeSelect =
            document.getElementById(
                'maxlow-size-select'
            );


        const positionSelect =
            document.getElementById(
                'maxlow-position-select'
            );


        const modeSelect =
            document.getElementById(
                'maxlow-mode-select'
            );


        boardEnabled.checked = !!settings.boardCameraEnabled;
        boardSelect.disabled = !settings.boardCameraEnabled;
        boardSelect.style.opacity = settings.boardCameraEnabled ? '1' : '.45';

        audioEnabled.checked = !!settings.audioEnabled;
        audioSelect.disabled = !settings.audioEnabled;
        audioSelect.style.opacity = settings.audioEnabled ? '1' : '.45';

        audioEnabled.addEventListener('change', async e => {
            settings.audioEnabled = !!e.target.checked;
            audioSelect.disabled = !settings.audioEnabled;
            audioSelect.style.opacity = settings.audioEnabled ? '1' : '.45';
            saveSettings();
            await startMicrophone();
            if (settings.mode === 'online') {
                try { onlinePeer?.close(); } catch {}
                onlinePeer = null;
                remoteStream = null;
                remoteBoardStream = null;
                remoteVideoTrackCount = 0;
                if (onlineSocket?.readyState === WebSocket.OPEN && onlineCameraPeerId) {
                    createOfferIfCaller().catch(console.warn);
                }
            }
        });

        audioSelect.addEventListener('change', async e => {
            settings.audioDeviceId = e.target.value;
            saveSettings();
            if (settings.audioEnabled) await startMicrophone();
        });
sizeSelect.value =
            settings.size;


        positionSelect.value =
            settings.position;


        modeSelect.value =
            settings.mode;

        updatePinDisplay();


        boardEnabled.addEventListener('change', async e => {
            settings.boardCameraEnabled = !!e.target.checked;
            boardSelect.disabled = !settings.boardCameraEnabled;
            boardSelect.style.opacity = settings.boardCameraEnabled ? '1' : '.45';
            saveSettings();

            await startBoardCamera();

            // Rebuild WebRTC so the new track layout is negotiated cleanly.
            if (settings.mode === 'online') {
                const state = findMatchState();
                const keepPeerId = onlineCameraPeerId;
                stopOnlineMode();
                onlineCameraPeerId = keepPeerId;
                if (state) startOnlineMode();
            }
        });

        boardSelect.addEventListener('change', async e => {
            settings.boardDeviceId = e.target.value;
            saveSettings();
            if (settings.boardCameraEnabled) {
                await startBoardCamera();

                if (settings.mode === 'online') {
                    const state = findMatchState();
                    const keepPeerId = onlineCameraPeerId;
                    stopOnlineMode();
                    onlineCameraPeerId = keepPeerId;
                    if (state) startOnlineMode();
                }
            }
        });

        sizeSelect.addEventListener(
            'change',
            e => {

                settings.size =
                    e.target.value;

                saveSettings();

                applyCameraLayout();
            }
        );


        positionSelect.addEventListener(
            'change',
            e => {

                settings.position =
                    e.target.value;

                saveSettings();

                applyCameraLayout();
            }
        );


        modeSelect.addEventListener(
            'change',
            e => {

                settings.mode =
                    e.target.value;

                saveSettings();

                const video = createCamera();
                const wrapper = document.getElementById(WRAPPER_ID);

                if (settings.mode === 'local') {
                    stopOnlineMode();
                    video.srcObject = cameraStream;
                    if (wrapper && cameraEnabled) {
                        wrapper.style.display = 'block';
                    }
                } else {
                    // Keep the existing camera viewport visible while
                    // Online Mode establishes the opponent connection.
                    video.srcObject = remoteStream || cameraStream;
                    video.muted = true;
                    if (wrapper && cameraEnabled) {
                        wrapper.style.display = 'block';
                    }
                    video.play().catch(() => {});
                    startOnlineMode();
                }
            }
        );


        populateCameraList();
    }


    // ============================================================
    // CAMERA LIST
    // ============================================================

    async function populateCameraList() {
        const playerSelect = document.getElementById('maxlow-camera-select');
        const boardSelect = document.getElementById('maxlow-board-camera-select');
        const audioSelect = document.getElementById('maxlow-audio-select');

        if (!playerSelect && !boardSelect && !audioSelect) return;

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cameras = devices.filter(device => device.kind === 'videoinput');
            const microphones = devices.filter(device => device.kind === 'audioinput');

            const fill = (select, selectedId, defaultLabel) => {
                if (!select) return;
                select.innerHTML = `<option value="">${defaultLabel}</option>`;

                cameras.forEach((camera, index) => {
                    const option = document.createElement('option');
                    option.value = camera.deviceId;
                    option.textContent = camera.label || `Camera ${index + 1}`;
                    select.appendChild(option);
                });

                select.value = selectedId || '';
            };

            fill(playerSelect, settings.deviceId, 'Default camera');
            fill(boardSelect, settings.boardDeviceId, 'Default / second camera');

            if (audioSelect) {
                audioSelect.innerHTML = '<option value="">Default microphone</option>';
                microphones.forEach((mic, index) => {
                    const option = document.createElement('option');
                    option.value = mic.deviceId;
                    option.textContent = mic.label || `Microphone ${index + 1}`;
                    audioSelect.appendChild(option);
                });
                audioSelect.value = settings.audioDeviceId || '';
            }

            if (playerSelect) {
                playerSelect.onchange = async e => {
                    settings.deviceId = e.target.value;
                    saveSettings();
                    await startCamera();
                };
            }
        } catch (error) {
            console.error('MAXLOW: Could not list cameras', error);
        }
    }


    // ============================================================
    // ONLINE PLAYER CAM
    // Uses Autodarts' React match state discovered in our diagnostic:
    // state.userId, state.gameClient.players, state.activePlayer,
    // state.isActivePlayer.
    // ============================================================

    function getMatchId() {
        return location.pathname.match(/\/matches\/([^/?#]+)/)?.[1] || null;
    }

    function isUsefulMatchState(value) {
        return !!(
            value &&
            typeof value === 'object' &&
            typeof value.userId === 'string' &&
            value.gameClient &&
            Array.isArray(value.gameClient.players) &&
            value.activePlayer &&
            typeof value.isActivePlayer === 'boolean'
        );
    }

    function findMatchState() {
        const nodes = document.querySelectorAll('body *');

        for (const node of nodes) {
            let keys = [];
            try {
                keys = Object.getOwnPropertyNames(node);
            } catch {
                continue;
            }

            const fiberKey = keys.find(k => k.startsWith('__reactFiber$'));
            if (!fiberKey) continue;

            let fiber = node[fiberKey];
            let hops = 0;

            while (fiber && hops < 50) {
                for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
                    if (!props || typeof props !== 'object') continue;

                    if (isUsefulMatchState(props.state)) {
                        return props.state;
                    }

                    try {
                        for (const value of Object.values(props)) {
                            if (isUsefulMatchState(value)) {
                                return value;
                            }
                        }
                    } catch {}
                }

                fiber = fiber.return;
                hops++;
            }
        }

        return null;
    }

    function makeIdentity(state) {
        const matchId = getMatchId();
        if (!matchId || !state) return null;
        return {
            matchId,
            // IMPORTANT: both players are in the same match, so matchId alone
            // gives both browsers the same signalling ID. Include the logged-in
            // Autodarts user ID so each receiver has a unique endpoint.
            myId: `autodarts:${matchId}:${state.userId}`,
            opponentId: onlineCameraPeerId || ''
        };
    }

    function updatePinDisplay() {
        const el = document.getElementById('maxlow-online-pin');
        if (el) el.textContent = onlinePairingPin || '------';
    }

    function showCorrectOnlineVideo(state) {
        if (settings.mode !== 'online') return;

        const video = createCamera();
        const wrapper = document.getElementById(WRAPPER_ID);
        if (!wrapper) return;

        // Until the Linux sender connects, keep our local preview visible.
        if (!remoteStream) {
            if (cameraStream && video.srcObject !== cameraStream) {
                video.srcObject = cameraStream;
            }
            showBoardVideo(settings.boardCameraEnabled ? boardCameraStream : null);
            video.muted = true;
            if (cameraEnabled) wrapper.style.display = 'block';
            video.play().catch(() => {});
            return;
        }

        // Once the remote camera is live, compare the ACTIVE PLAYER
        // with the logged-in Autodarts user. isActivePlayer is true for
        // whichever player-state object is active, so it is not a
        // reliable "is this me?" flag.
        const activeUserId = state?.activePlayer?.userId || null;
        const myUserId = state?.userId || null;
        const isMyTurn = !!myUserId && activeUserId === myUserId;

        if (isMyTurn) {
            // v0.7.5: show our own local camera on our screen while we throw.
            // The same local stream continues to be sent to the opponent.
            if (cameraStream && video.srcObject !== cameraStream) {
                video.srcObject = cameraStream;
            }

            video.muted = true;
            wrapper.style.display = cameraEnabled ? 'block' : 'none';
            showBoardVideo(settings.boardCameraEnabled ? boardCameraStream : null);
            video.play().catch(() => {});

            if (lastTurnState !== true) {
                console.log(
                    'MAXLOW: MY TURN - local camera shown on both screens',
                    state?.activePlayer?.name
                );
                lastTurnState = true;
            }
            return;
        }

        if (video.srcObject !== remoteStream) {
            video.srcObject = remoteStream;
        }

        video.muted = true;
        wrapper.style.display = cameraEnabled ? 'block' : 'none';
        showBoardVideo(remoteBoardStream);
        video.play().catch(() => {});

        if (lastTurnState !== false) {
            console.log(
                'MAXLOW: OPPONENT TURN - opponent camera shown',
                state?.activePlayer?.name
            );
            lastTurnState = false;
        }
    }

    // ONE-PIN TWO-WAY BRIDGE
    window.addEventListener('maxlow-sender-remote-stream', event => {
        const stream = event.detail?.stream;
        if (!stream) return;

        if (event.detail?.kind === 'board') {
            remoteBoardStream = stream;
            console.log('MAXLOW: TWO-WAY RETURN BOARD CAMERA ATTACHED');
        } else {
            remoteStream = stream;
            console.log('MAXLOW: TWO-WAY RETURN PLAYER CAMERA ATTACHED');
        }
        const state = findMatchState();
        if (state) showCorrectOnlineVideo(state);
    });

    function sendOnline(data) {
        if (onlineSocket?.readyState === WebSocket.OPEN) {
            onlineSocket.send(JSON.stringify(data));
        }
    }

    async function flushIce() {
        if (!onlinePeer?.remoteDescription) return;

        const queued = pendingIce.splice(0);

        for (const candidate of queued) {
            try {
                await onlinePeer.addIceCandidate(candidate);
            } catch (error) {
                console.warn('MAXLOW: queued ICE error', error);
            }
        }
    }

    async function prepareOnlinePeer() {
        if (onlinePeer) return onlinePeer;
        if (!cameraStream || !onlineIdentity) return null;

        onlinePeer = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });

        // Reuse the exact cameraStream created by the proven local mode.
        cameraStream.getTracks().forEach(track => {
            onlinePeer.addTrack(track, cameraStream);
        });

        if (settings.boardCameraEnabled && boardCameraStream) {
            boardCameraStream.getTracks().forEach(track => {
                onlinePeer.addTrack(track, boardCameraStream);
            });
        } else {
            // Always reserve the second video m-line so a paired sender can
            // optionally return a board camera without making it mandatory.
            onlinePeer.addTransceiver('video', { direction: 'recvonly' });
        }

        if (settings.audioEnabled && microphoneStream) {
            microphoneStream.getAudioTracks().forEach(track => onlinePeer.addTrack(track, microphoneStream));
        } else {
            onlinePeer.addTransceiver('audio', { direction: 'recvonly' });
        }

        onlineChatChannel = onlinePeer.createDataChannel('maxlow-chat', { ordered:true });
        setChatChannel(onlineChatChannel);

        remoteVideoTrackCount = 0;

        onlinePeer.ontrack = event => {
            const incoming =
                event.streams?.[0] ||
                new MediaStream([event.track]);

            if (event.track.kind === 'audio') {
                remoteAudioStream = incoming;
                playRemoteAudio(incoming);
                console.log('MAXLOW: REMOTE AUDIO RECEIVED');
                return;
            }

            const isBoardTrack = remoteVideoTrackCount > 0;
            remoteVideoTrackCount++;

            if (isBoardTrack) {
                remoteBoardStream = incoming;
                console.log('MAXLOW: REMOTE OCHE TRACK RECEIVED');
                const state = findMatchState();
                if (state) showCorrectOnlineVideo(state);
                return;
            }

            console.log('MAXLOW: REMOTE PLAYER TRACK RECEIVED');
            remoteStream = incoming;

            const video = createCamera();
            video.srcObject = remoteStream;
            video.muted = true;
            video.playsInline = true;

            video.play()
                .then(() => console.log('MAXLOW: OPPONENT CAMERA ATTACHED'))
                .catch(error => console.warn('MAXLOW: video play', error));

            const state = findMatchState();
            if (state) showCorrectOnlineVideo(state);
        };

        onlinePeer.onicecandidate = event => {
            if (!event.candidate) return;

            sendOnline({
                type: 'ice',
                target: onlineIdentity.opponentId,
                from: onlineIdentity.myId,
                candidate: event.candidate
            });
        };

        onlinePeer.oniceconnectionstatechange = () => {
            console.log('MAXLOW ICE:', onlinePeer?.iceConnectionState);
        };

        onlinePeer.onconnectionstatechange = () => {
            const state = onlinePeer?.connectionState;
            console.log('MAXLOW WebRTC:', state);

            if (state === 'connected') {
                if (peerRecoveryTimer) {
                    clearTimeout(peerRecoveryTimer);
                    peerRecoveryTimer = null;
                }
                return;
            }

            if (state === 'disconnected' || state === 'failed') {
                if (peerRecoveryTimer) return;

                console.log('MAXLOW: VIDEO CONNECTION LOST - RECOVERY SCHEDULED');

                peerRecoveryTimer = setTimeout(() => {
                    peerRecoveryTimer = null;
                    if (settings.mode !== 'online' || intentionalOnlineStop) return;

                    try { onlinePeer?.close(); } catch {}
                    onlinePeer = null;
                    remoteStream = null;
                    remoteBoardStream = null;
                    remoteVideoTrackCount = 0;
                    pendingIce = [];

                    console.log('MAXLOW: ATTEMPTING AUTOMATIC VIDEO RECOVERY');

                    if (onlineSocket?.readyState === WebSocket.OPEN && onlineCameraPeerId) {
                        createOfferIfCaller().catch(error =>
                            console.warn('MAXLOW: automatic offer recovery failed', error)
                        );
                    } else {
                        connectOnlineSocket();
                    }
                }, 3000);
            }
        };

        return onlinePeer;
    }

    async function createOfferIfCaller() {
        if (!onlineIdentity || !onlineCameraPeerId ||
            onlineSocket?.readyState !== WebSocket.OPEN) return;

        const peer = await prepareOnlinePeer();
        if (!peer || peer.signalingState !== 'stable') return;

        // Single PIN pairing: send our camera AND request theirs.
        const offer = await peer.createOffer({ offerToReceiveVideo: true });
        await peer.setLocalDescription(offer);

        sendOnline({
            type: 'offer',
            target: onlineCameraPeerId,
            from: onlineIdentity.myId,
            offer: peer.localDescription
        });

        console.log('MAXLOW: ONLINE OFFER SENT TO PAIRED CAMERA');
    }

    function connectOnlineSocket() {
        if (!onlineIdentity) return;
        if (onlineSocket &&
            (onlineSocket.readyState === WebSocket.OPEN ||
             onlineSocket.readyState === WebSocket.CONNECTING)) return;

        onlineSocket = new WebSocket(SIGNAL_URL);

        onlineSocket.onopen = () => {
            console.log('MAXLOW: CONNECTED TO PIN SIGNALLING SERVER');

            if (onlineReconnectTimer) {
                clearTimeout(onlineReconnectTimer);
                onlineReconnectTimer = null;
            }

            // Re-register this Autodarts side with the PIN server.
            // If a camera was already paired, keep its peer ID so we can
            // automatically send it a fresh WebRTC offer after reconnecting.
            sendOnline({ type: 'create_pin', id: onlineIdentity.myId });

            if (onlineCameraPeerId && !remoteStream) {
                setTimeout(() => {
                    createOfferIfCaller().catch(error =>
                        console.warn('MAXLOW: reconnect offer failed', error)
                    );
                }, 500);
            }
        };

        onlineSocket.onmessage = async event => {
            try {
                const data = JSON.parse(event.data);
                console.log('MAXLOW SIGNAL:', data.type, 'FROM:', data.from);

                if (data.type === 'pin_created' && data.pin) {
                    onlinePairingPin = String(data.pin);
                    updatePinDisplay();
                    console.log('MAXLOW: PAIRING PIN', onlinePairingPin);
                    return;
                }

                if (data.type === 'camera_paired' && data.peer) {
                    onlineCameraPeerId = data.peer;
                    onlineIdentity.opponentId = data.peer;
                    console.log('MAXLOW: CAMERA PAIRED', data.peer);
                    await createOfferIfCaller();
                    return;
                }

                if (data.target && data.target !== onlineIdentity.myId) return;

                if (data.type === 'offer' && data.offer) {
                    const peer = await prepareOnlinePeer();
                    await peer.setRemoteDescription(data.offer);
                    await flushIce();
                    const answer = await peer.createAnswer();
                    await peer.setLocalDescription(answer);
                    sendOnline({
                        type: 'answer',
                        target: data.from,
                        from: onlineIdentity.myId,
                        answer: peer.localDescription
                    });
                    console.log('MAXLOW: ONLINE ANSWER SENT');
                    return;
                }

                if (data.type === 'answer' && data.answer) {
                    const peer = await prepareOnlinePeer();
                    if (peer.signalingState === 'have-local-offer') {
                        await peer.setRemoteDescription(data.answer);
                        console.log('MAXLOW: REMOTE ANSWER SET');
                        await flushIce();
                    }
                    return;
                }

                if (data.type === 'ice' && data.candidate) {
                    if (onlinePeer?.remoteDescription) {
                        try { await onlinePeer.addIceCandidate(data.candidate); }
                        catch (error) { console.warn('MAXLOW: ICE add failed', error); }
                    } else {
                        pendingIce.push(data.candidate);
                        console.log('MAXLOW: ICE candidate queued');
                    }
                }
            } catch (error) {
                console.error('MAXLOW: SIGNAL ERROR', error);
            }
        };

        onlineSocket.onerror = error =>
            console.warn('MAXLOW: signalling socket error', error);

        onlineSocket.onclose = () => {
            console.log('MAXLOW: signalling socket closed');
            onlineSocket = null;
            onlinePairingPin = '';
            updatePinDisplay();

            if (settings.mode !== 'online' || intentionalOnlineStop) return;
            if (onlineReconnectTimer) return;

            console.log('MAXLOW: SIGNALLING RECONNECT IN 3 SECONDS');

            onlineReconnectTimer = setTimeout(() => {
                onlineReconnectTimer = null;
                if (settings.mode === 'online' && !intentionalOnlineStop) {
                    console.log('MAXLOW: RECONNECTING TO SIGNALLING SERVER');
                    connectOnlineSocket();
                }
            }, 3000);
        };
    }

    function stopOnlineMode() {
        intentionalOnlineStop = true;

        if (onlineReconnectTimer) {
            clearTimeout(onlineReconnectTimer);
            onlineReconnectTimer = null;
        }

        if (peerRecoveryTimer) {
            clearTimeout(peerRecoveryTimer);
            peerRecoveryTimer = null;
        }

        if (onlinePeer) {
            try { onlinePeer.close(); } catch {}
        }

        if (onlineSocket) {
            try {
                onlineSocket.onclose = null;
                onlineSocket.close();
            } catch {}
        }

        onlinePeer = null;
        onlineSocket = null;
        remoteStream = null;
        remoteBoardStream = null;
        remoteAudioStream = null;
        remoteVideoTrackCount = 0;
        setChatChannel(null);
        const remoteAudio = document.getElementById('maxlow-remote-audio');
        if (remoteAudio) remoteAudio.srcObject = null;
        showBoardVideo(null);
        pendingIce = [];
        onlineIdentity = null;
        lastTurnState = null;
    }

    function stopAllCameraCapture() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(track => track.stop());
            cameraStream = null;
        }

        if (boardCameraStream) {
            boardCameraStream.getTracks().forEach(track => track.stop());
            boardCameraStream = null;
        }

        const video = document.getElementById(CAMERA_ID);
        if (video) video.srcObject = null;

        showBoardVideo(null);

        const wrapper = document.getElementById(WRAPPER_ID);
        if (wrapper) wrapper.style.display = 'none';

        cameraEnabled = false;
        updateCamButton();
    }

    function matchLooksFinished(state) {
        try {
            const finishedValues = new Set([
                'finished', 'complete', 'completed', 'ended',
                'gameover', 'game_over', 'game-over'
            ]);

            const candidates = [
                state,
                state?.game,
                state?.match,
                state?.gameClient,
                state?.gameClient?.state
            ].filter(Boolean);

            for (const obj of candidates) {
                for (const key of ['status', 'state', 'phase', 'gameStatus', 'matchStatus']) {
                    const value = String(obj?.[key] ?? '').toLowerCase().replace(/\s+/g, '');
                    if (finishedValues.has(value)) return true;
                }

                for (const key of [
                    'finished', 'isFinished', 'complete', 'completed',
                    'gameOver', 'isGameOver', 'ended', 'isEnded'
                ]) {
                    if (obj?.[key] === true) return true;
                }

                // Common winner/result signals.
                if (obj?.winnerId || obj?.winner || obj?.winningPlayerId) return true;
            }

            const path = location.pathname.toLowerCase();
            const bodyText = (document.body?.innerText || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

            // Result/end controls Autodarts may show after the winning dart.
            const exactEndControls = new Set([
                'rematch', 'play again', 'new match', 'back to lobby',
                'leave match', 'match finished', 'game finished'
            ]);

            const controls = [...document.querySelectorAll('button, [role="button"], a')];
            for (const el of controls) {
                const label = String(
                    el.innerText || el.textContent ||
                    el.getAttribute('aria-label') ||
                    el.getAttribute('title') || ''
                ).trim().toLowerCase();
                if (exactEndControls.has(label)) return true;
            }

            // Strong result phrases. Avoid generic "winner" alone because themes may contain it.
            const resultPhrases = [
                'match complete', 'match completed', 'match finished',
                'game complete', 'game completed', 'game finished',
                'play again', 'back to lobby'
            ];
            if (resultPhrases.some(p => bodyText.includes(p))) return true;

            // If Autodarts has navigated away from the active /matches/<id> route,
            // an online camera session must not remain alive.
            if (onlineIdentity?.matchId && !path.includes(`/matches/${String(onlineIdentity.matchId).toLowerCase()}`)) {
                return true;
            }
        } catch (error) {
            console.warn('MAXLOW: match-end detection error', error);
        }

        return false;
    }


    async function runWorkingAudioResetPath() {
        // This intentionally mirrors the LIVE AUDIO toggle path from v0.9.12.
        settings.audioEnabled = false;
        saveSettings();
        await startMicrophone();

        if (settings.mode === 'online') {
            try { onlinePeer?.close(); } catch {}
            onlinePeer = null;
            remoteStream = null;
            remoteBoardStream = null;
            remoteVideoTrackCount = 0;
        }
    }



    function stopMaxlowAudioOnHistory() {
        if (!location.pathname.toLowerCase().includes('/history/matches/')) return;

        // Stop the local microphone capture.
        try { microphoneStream?.getTracks().forEach(track => track.stop()); } catch {}
        microphoneStream = null;

        // Stop/clear every remote audio element used by Maxlow.
        const knownAudio = document.getElementById('maxlow-remote-audio');
        if (knownAudio) {
            try { knownAudio.pause(); } catch {}
            try { knownAudio.srcObject?.getTracks().forEach(track => track.stop()); } catch {}
            knownAudio.srcObject = null;
            try { knownAudio.removeAttribute('src'); } catch {}
            try { knownAudio.load(); } catch {}
        }

        // Belt-and-braces: clear audio tracks from the stored remote stream too.
        try { remoteAudioStream?.getTracks().forEach(track => track.stop()); } catch {}
        remoteAudioStream = null;
    }

    function removeMaxlowCameraViewsOnHistory() {
        if (!location.pathname.toLowerCase().includes('/history/matches/')) return;

        for (const id of [WRAPPER_ID, BOARD_WRAPPER_ID]) {
            const wrapper = document.getElementById(id);
            if (wrapper) wrapper.remove();
        }

        // Also remove any stale Maxlow video nodes if a wrapper was recreated oddly.
        for (const id of [CAMERA_ID, BOARD_CAMERA_ID]) {
            const video = document.getElementById(id);
            if (video) {
                try { video.pause(); } catch {}
                try { video.srcObject = null; } catch {}
                video.remove();
            }
        }
    }

    // Autodarts is a SPA, so watch continuously for the result/history route
    // and remove any camera UI that gets recreated after navigation.
    window.setInterval(() => {
        removeMaxlowCameraViewsOnHistory();
        stopMaxlowAudioOnHistory();
    }, 100);

    async function finishOnlineMatch() {
        const matchId = onlineIdentity?.matchId || getMatchId() || '';
        if (matchId) endedMatchId = matchId;

        console.log('MAXLOW: MATCH FINISHED - USING WORKING AUDIO RESET PATH');
        await runWorkingAudioResetPath();
        stopOnlineMode();
        stopAllCameraCapture();
        setTimeout(() => {
            removeMaxlowCameraViewsOnHistory();
            stopMaxlowAudioOnHistory();
        }, 0);
        setTimeout(() => {
            removeMaxlowCameraViewsOnHistory();
            stopMaxlowAudioOnHistory();
        }, 150);

        // Force the visual overlays away immediately at match end.
        const mainWrapper = document.getElementById(WRAPPER_ID);
        const boardWrapper = document.getElementById(BOARD_WRAPPER_ID);
        if (mainWrapper) mainWrapper.style.setProperty('display', 'none', 'important');
        if (boardWrapper) boardWrapper.style.setProperty('display', 'none', 'important');

        const chatPanel = document.getElementById('maxlow-chat-panel');
        if (chatPanel) chatPanel.remove();
    }


    document.addEventListener('click', event => {
        const control = event.target?.closest?.('button, [role="button"], a');
        if (!control) return;

        const label = String(
            control.innerText || control.textContent ||
            control.getAttribute('aria-label') ||
            control.getAttribute('title') || ''
        ).replace(/\s+/g, ' ').trim().toLowerCase();

        const endActions = [
            'abort', 'surrender', 'leave match', 'leave game',
            'quit match', 'quit game', 'back to lobby'
        ];

        if (endActions.some(action => label === action || label.includes(action))) {
            console.log('MAXLOW: END ACTION CLICKED:', label);
            setTimeout(() => finishOnlineMatch().catch(console.warn), 150);
        }
    }, true);

    function startOnlineMode() {
        if (settings.mode !== 'online') return;

        const currentMatchId = getMatchId();
        if (endedMatchId && currentMatchId === endedMatchId) return;
        if (endedMatchId && currentMatchId && currentMatchId !== endedMatchId) {
            endedMatchId = '';
        }

        intentionalOnlineStop = false;
        if (!location.pathname.includes('/matches/')) return;

        const state = findMatchState();

        if (!state) {
            console.log('MAXLOW: waiting for Autodarts React state');
            return;
        }

        const nextIdentity = makeIdentity(state);

        if (!nextIdentity) {
            console.log('MAXLOW: waiting for match identity');
            showCorrectOnlineVideo(state);
            return;
        }

        const changed =
            !onlineIdentity ||
            onlineIdentity.myId !== nextIdentity.myId ||
            onlineIdentity.opponentId !== nextIdentity.opponentId;

        if (changed) {
            stopOnlineMode();
            onlineIdentity = nextIdentity;

            console.log('======================================');
            console.log('MAXLOW: AUTOMATIC PLAYER IDENTITY');
            console.log('MATCH:', onlineIdentity.matchId);
            console.log('AUTODARTS ROLE:', onlineIdentity.myId);
            console.log('CAMERA ROLE:', onlineIdentity.opponentId);
            console.log('ACTIVE PLAYER:', state.activePlayer?.name);
            console.log('IS MY TURN:', state.isActivePlayer);
            console.log('======================================');
        }

        showCorrectOnlineVideo(state);
        connectOnlineSocket();
    }

    // Autodarts changes React state without reloading the page.
    setInterval(async () => {
        if (settings.mode !== 'online') return;

        const currentMatchId = getMatchId();

        // Leaving the match route also guarantees teardown.
        if (onlineIdentity && !currentMatchId) {
            finishOnlineMatch();
            return;
        }

        const state = findMatchState();

        if (onlineIdentity && matchLooksFinished(state)) {
            finishOnlineMatch();
            return;
        }

        if (endedMatchId && currentMatchId === endedMatchId) return;

        if (endedMatchId && currentMatchId && currentMatchId !== endedMatchId) {
            endedMatchId = '';
        }

        // A new match can restart capture automatically after the previous
        // match deliberately released both cameras.
        if (currentMatchId && !cameraStream) {
            await startCamera();
        }

        if (state) {
            showCorrectOnlineVideo(state);

            if (!onlineIdentity || !onlineSocket) {
                startOnlineMode();
            }
        }
    }, 500);


    // ============================================================
    // AUTODARTS TOOLBAR WATCHER
    // ============================================================

    setInterval(
        createToolbarControls,
        750
    );


    // ============================================================
    // START
    // ============================================================

    setTimeout(
        async () => {
            await startCamera();
            if (settings.boardCameraEnabled && !boardCameraStream) {
                await startBoardCamera();
            }

            if (settings.mode === 'online') {
                setTimeout(startOnlineMode, 750);
            }
        },
        2000
    );

})();

/* ===== MAXLOW UNIVERSAL SEND-MY-CAMERA MODULE ===== */
(() => {
    'use strict';

    const SIGNAL_URL = 'wss://maxlow-player-cam-server.onrender.com/ws';
    const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

    let socket = null;
    let peer = null;
    let localStream = null;
    let boardStream = null;
    let microphoneStream = null;
    let pendingIce = [];
    let remoteTrackCount = 0;
    let cameraId = localStorage.getItem('maxlowSenderCameraId') || '';
    let boardCameraId = localStorage.getItem('maxlowSenderBoardCameraId') || '';
    let boardEnabled = localStorage.getItem('maxlowSenderBoardEnabled') === 'true';
    let audioEnabled = localStorage.getItem('maxlowSenderAudioEnabled') === 'true';
    let audioDeviceId = localStorage.getItem('maxlowSenderAudioDeviceId') || '';
    let senderId = sessionStorage.getItem('maxlowSenderId');

    if (!senderId) {
        senderId = 'camera:' + (crypto.randomUUID ? crypto.randomUUID() :
            Date.now().toString(36) + Math.random().toString(36).slice(2));
        sessionStorage.setItem('maxlowSenderId', senderId);
    }

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        Object.assign(node, props);
        for (const child of children) {
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return node;
    }

    function openSender() {
        if (document.getElementById('maxlow-sender-overlay')) return;

        const overlay = el('div', { id: 'maxlow-sender-overlay' });
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '2147483647',
            background: 'rgba(0,0,0,.82)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontFamily: 'Arial, sans-serif'
        });

        const panel = el('div');
        Object.assign(panel.style, {
            width: 'min(92vw, 520px)',
            background: 'linear-gradient(180deg, rgba(8,13,22,.99), rgba(3,7,13,.99))',
            color: '#fff',
            border: '1px solid #2388ff',
            borderRadius: '6px',
            padding: '18px',
            boxShadow: '0 0 0 1px rgba(215,25,32,.65), 0 0 24px rgba(35,136,255,.25), 0 20px 60px rgba(0,0,0,.7)'
        });

        const brand = el('div');
        Object.assign(brand.style, {
            display:'flex', justifyContent:'center', alignItems:'center',
            margin:'0 auto 5px', width:'max-content',
            fontSize:'16px', fontWeight:'900', lineHeight:'27px',
            fontFamily:'Arial, sans-serif', borderRadius:'2px', overflow:'hidden',
            boxShadow:'0 0 10px rgba(0,0,0,.6)'
        });
        const brandBlue = el('span', { textContent:'Maxlow' });
        Object.assign(brandBlue.style, { background:'#1558b0', color:'#fff', padding:'0 10px' });
        const brandRed = el('span', { textContent:'Designs' });
        Object.assign(brandRed.style, { background:'#d71920', color:'#fff', padding:'0 10px' });
        brand.append(brandBlue, brandRed);

        const title = el('div', { textContent: 'PIN INPUT' });
        Object.assign(title.style, {
            fontSize:'11px', fontWeight:'900', textAlign:'center',
            letterSpacing:'1.6px', color:'#cbd5e1', marginTop:'7px'
        });

        const subtitle = el('div', { textContent: 'PLAYER CAMERA SENDER' });
        Object.assign(subtitle.style, {
            fontSize:'10px', textAlign:'center', opacity:'.65',
            letterSpacing:'.8px', margin:'4px 0 16px'
        });

        const pin = el('input', {
            id: 'maxlow-sender-pin', placeholder: '6 DIGIT PIN',
            inputMode: 'numeric', maxLength: 6
        });
        Object.assign(pin.style, {
            width:'100%', boxSizing:'border-box', padding:'13px',
            fontSize:'24px', letterSpacing:'8px', textAlign:'center',
            borderRadius:'3px', border:'1px solid #315b87',
            background:'#030712', color:'#fff', outline:'none'
        });
        pin.addEventListener('input', () => pin.value = pin.value.replace(/\D/g,'').slice(0,6));

        const select = el('select', { id:'maxlow-sender-camera' });
        Object.assign(select.style, {
            width:'100%', boxSizing:'border-box', marginTop:'12px', padding:'10px',
            borderRadius:'3px', border:'1px solid #315b87',
            background:'#030712', color:'#fff'
        });

        const boardToggleLabel = el('label');
        Object.assign(boardToggleLabel.style, {
            display:'flex', alignItems:'center', gap:'8px', marginTop:'12px',
            fontSize:'12px', fontWeight:'800'
        });

        const boardToggle = el('input', { type:'checkbox', checked:boardEnabled });
        const boardToggleText = el('span', { textContent:'OCHE CAMERA' });
        boardToggleLabel.append(boardToggle, boardToggleText);

        const boardSelect = el('select', { id:'maxlow-sender-board-camera' });
        Object.assign(boardSelect.style, {
            width:'100%', boxSizing:'border-box', marginTop:'8px', padding:'10px',
            borderRadius:'3px', border:'1px solid #315b87',
            background:'#030712', color:'#fff'
        });
        boardSelect.disabled = !boardEnabled;
        boardSelect.style.opacity = boardEnabled ? '1' : '.45';

        const boardPreview = el('video', {
            id:'maxlow-sender-board-preview', autoplay:true, muted:true, playsInline:true
        });
        Object.assign(boardPreview.style, {
            width:'100%', aspectRatio:'16/9', objectFit:'cover', background:'#000',
            borderRadius:'3px', border:'1px solid #315b87', marginTop:'8px', display:boardEnabled ? 'block' : 'none'
        });

        const audioToggleLabel = el('label');
        Object.assign(audioToggleLabel.style, {
            display:'flex', alignItems:'center', gap:'8px', marginTop:'12px',
            fontSize:'12px', fontWeight:'800'
        });
        const audioToggle = el('input', { type:'checkbox', checked:audioEnabled });
        const audioToggleText = el('span', { textContent:'LIVE AUDIO' });
        audioToggleLabel.append(audioToggle, audioToggleText);

        const audioSelect = el('select', { id:'maxlow-sender-audio' });
        Object.assign(audioSelect.style, {
            width:'100%', boxSizing:'border-box', marginTop:'8px', padding:'10px',
            borderRadius:'3px', border:'1px solid #315b87',
            background:'#030712', color:'#fff'
        });
        audioSelect.disabled = !audioEnabled;
        audioSelect.style.opacity = audioEnabled ? '1' : '.45';

        const preview = el('video', { id:'maxlow-sender-preview', autoplay:true, muted:true, playsInline:true });
        Object.assign(preview.style, {
            width:'100%', aspectRatio:'16/9', objectFit:'cover', background:'#000',
            borderRadius:'3px', border:'1px solid #315b87', marginTop:'12px'
        });

        const status = el('div', { id:'maxlow-sender-status', textContent:'Camera not started' });
        Object.assign(status.style, { textAlign:'center', margin:'12px 0', fontWeight:'700', fontSize:'13px' });

        const start = el('button', { textContent:'START / CHOOSE CAMERAS' });
        const connect = el('button', { textContent:'CONNECT CAMERAS' });
        const disconnect = el('button', { textContent:'DISCONNECT' });
        const close = el('button', { textContent:'CLOSE' });

        const buttonStyles = [
            [start, '#1558b0', 'START / CHOOSE CAMERAS'],
            [connect, '#d71920', 'CONNECT CAMERAS'],
            [disconnect, '#111827', 'DISCONNECT'],
            [close, '#05080d', 'CLOSE']
        ];
        for (const [b, bg, label] of buttonStyles) {
            b.textContent = label;
            Object.assign(b.style, {
                width:'100%', padding:'11px', marginTop:'8px',
                border:'1px solid rgba(255,255,255,.25)',
                borderRadius:'3px', cursor:'pointer', fontWeight:'900',
                background:bg, color:'#fff', letterSpacing:'.35px',
                boxShadow: bg === '#1558b0'
                    ? '0 0 12px rgba(35,136,255,.28)'
                    : bg === '#d71920'
                    ? '0 0 12px rgba(215,25,32,.25)'
                    : 'none'
            });
        }

        boardToggle.addEventListener('change', async () => {
            boardEnabled = !!boardToggle.checked;
            localStorage.setItem('maxlowSenderBoardEnabled', String(boardEnabled));
            boardSelect.disabled = !boardEnabled;
            boardSelect.style.opacity = boardEnabled ? '1' : '.45';
            boardPreview.style.display = boardEnabled ? 'block' : 'none';

            if (!boardEnabled && boardStream) {
                boardStream.getTracks().forEach(t => t.stop());
                boardStream = null;
                boardPreview.srcObject = null;
            }
        });

        boardSelect.addEventListener('change', () => {
            boardCameraId = boardSelect.value;
            if (boardCameraId) localStorage.setItem('maxlowSenderBoardCameraId', boardCameraId);
        });

        audioToggle.addEventListener('change', async () => {
            audioEnabled = !!audioToggle.checked;
            localStorage.setItem('maxlowSenderAudioEnabled', String(audioEnabled));
            audioSelect.disabled = !audioEnabled;
            audioSelect.style.opacity = audioEnabled ? '1' : '.45';
            if (!audioEnabled) {
                try { microphoneStream?.getTracks().forEach(t => t.stop()); } catch {}
                microphoneStream = null;
            }
        });

        audioSelect.addEventListener('change', () => {
            audioDeviceId = audioSelect.value;
            localStorage.setItem('maxlowSenderAudioDeviceId', audioDeviceId);
        });

        start.onclick = async () => {
            await startCamera(select, preview, status);
            if (boardEnabled) await startBoardCameraSender(boardSelect, boardPreview, status);
            if (audioEnabled) await startMicrophoneSender(audioSelect, status);
        };
        connect.onclick = () => connectToPin(pin.value, status);
        disconnect.onclick = () => disconnectSender(status);
        close.onclick = () => overlay.remove();

        const playerCameraLabel = el('div', { textContent:'BOARD CAMERA' });
        Object.assign(playerCameraLabel.style, {
            fontSize:'11px', fontWeight:'900', letterSpacing:'.5px',
            margin:'0 0 5px', color:'#fff'
        });

        panel.append(
            brand, title, subtitle, pin, playerCameraLabel,
            select, preview,
            boardToggleLabel, boardSelect, boardPreview,
            audioToggleLabel, audioSelect,
            status, start, connect, disconnect, close
        );
        overlay.append(panel);
        document.body.append(overlay);

        loadCameras(select, boardSelect, audioSelect).catch(console.warn);
    }

    async function loadCameras(select, boardSelect = null, audioSelect = null) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter(d => d.kind === 'videoinput');
        const mics = devices.filter(d => d.kind === 'audioinput');

        const fill = (target, selectedId) => {
            if (!target) return;
            target.innerHTML = '';
            cams.forEach((cam, i) => {
                const option = el('option', {
                    value: cam.deviceId,
                    textContent: cam.label || `Camera ${i + 1}`
                });
                if (cam.deviceId === selectedId) option.selected = true;
                target.append(option);
            });
        };

        fill(select, cameraId);
        fill(boardSelect, boardCameraId);

        if (audioSelect) {
            audioSelect.innerHTML = '<option value="">Default microphone</option>';
            mics.forEach((mic, i) => {
                const option = el('option', { value:mic.deviceId, textContent:mic.label || `Microphone ${i + 1}` });
                audioSelect.append(option);
            });
            audioSelect.value = audioDeviceId || '';
        }
    }

    async function startCamera(select, preview, status) {
        try {
            if (localStream) localStream.getTracks().forEach(t => t.stop());

            const chosen = select.value || cameraId;
            const constraints = {
                video: chosen
                    ? { deviceId:{exact:chosen}, width:{ideal:1280}, height:{ideal:720} }
                    : { width:{ideal:1280}, height:{ideal:720} },
                audio: false
            };

            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            preview.srcObject = localStream;

            const track = localStream.getVideoTracks()[0];
            const settings = track.getSettings();
            cameraId = settings.deviceId || chosen || '';
            if (cameraId) localStorage.setItem('maxlowSenderCameraId', cameraId);

            await loadCameras(select);
            if (cameraId) select.value = cameraId;
            status.textContent = 'CAMERA READY';
            console.log('SEND MY CAMERA: CAMERA READY');
        } catch (e) {
            status.textContent = 'CAMERA ERROR - CHECK PERMISSION';
            console.error('SEND MY CAMERA camera error', e);
        }
    }

    async function startBoardCameraSender(select, preview, status) {
        if (!boardEnabled) return;

        try {
            if (boardStream) boardStream.getTracks().forEach(t => t.stop());

            const chosen = select.value || boardCameraId;
            if (!chosen) {
                status.textContent = 'CHOOSE A BOARD CAMERA';
                return;
            }

            // Prevent accidentally selecting the same physical camera twice.
            if (chosen === cameraId) {
                status.textContent = 'BOARD CAMERA MUST BE A DIFFERENT CAMERA';
                return;
            }

            boardStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: { exact: chosen },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });

            preview.srcObject = boardStream;
            const track = boardStream.getVideoTracks()[0];
            boardCameraId = track.getSettings().deviceId || chosen;
            localStorage.setItem('maxlowSenderBoardCameraId', boardCameraId);
            status.textContent = 'PLAYER + BOARD CAMERAS READY';
            console.log('SEND MY CAMERA: BOARD CAMERA READY');
        } catch (e) {
            boardStream = null;
            preview.srcObject = null;
            status.textContent = 'BOARD CAMERA ERROR - CHECK PERMISSION';
            console.error('SEND MY CAMERA board camera error', e);
        }
    }

    function send(data) {
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(data));
        }
    }


    async function startMicrophoneSender(select, status) {
        if (!audioEnabled) return;
        try {
            try { microphoneStream?.getTracks().forEach(t => t.stop()); } catch {}
            audioDeviceId = select?.value || audioDeviceId || '';
            localStorage.setItem('maxlowSenderAudioDeviceId', audioDeviceId);

            microphoneStream = await navigator.mediaDevices.getUserMedia({
                video:false,
                audio: audioDeviceId
                    ? { deviceId:{ exact:audioDeviceId }, echoCancellation:true, noiseSuppression:true, autoGainControl:true }
                    : { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
            });
            status.textContent = boardEnabled ? 'PLAYER + BOARD + AUDIO READY' : 'PLAYER + AUDIO READY';
            console.log('SEND MY CAMERA: MICROPHONE READY');
        } catch (e) {
            console.error('SEND MY CAMERA microphone error', e);
            microphoneStream = null;
            status.textContent = 'MICROPHONE ERROR - CHECK PERMISSION';
        }
    }

    async function preparePeer(target, status) {
        try { peer?.close(); } catch {}
        peer = new RTCPeerConnection({ iceServers: STUN_SERVERS });
        pendingIce = [];

        if (!localStream) throw new Error('Start camera first');

        localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

        if (boardEnabled && boardStream) {
            boardStream.getTracks().forEach(track => peer.addTrack(track, boardStream));
        }

        if (audioEnabled && microphoneStream) {
            microphoneStream.getAudioTracks().forEach(track => peer.addTrack(track, microphoneStream));
        }

        peer.ondatachannel = event => {
            if (event.channel?.label === 'maxlow-chat') {
                window.__maxlowChatChannel = event.channel;
                if (typeof window.maxlowSetChatChannel === 'function') window.maxlowSetChatChannel(event.channel);
                else {
                    event.channel.onmessage = e => {
                        if (typeof window.maxlowChatReceive === 'function') window.maxlowChatReceive(String(e.data || ''));
                    };
                }
            }
        };

        remoteTrackCount = 0;

        // Receive the PIN owner's player camera and optional board camera back.
        peer.ontrack = event => {
            const incoming =
                event.streams?.[0] ||
                new MediaStream([event.track]);

            if (event.track.kind === 'audio') {
                let audio = document.getElementById('maxlow-remote-audio');
                if (!audio) {
                    audio = document.createElement('audio');
                    audio.id = 'maxlow-remote-audio';
                    audio.autoplay = true;
                    audio.playsInline = true;
                    document.body.appendChild(audio);
                }
                audio.srcObject = incoming;
                audio.play().catch(() => console.warn('SEND MY CAMERA: click page once to allow audio'));
                console.log('SEND MY CAMERA: RETURN AUDIO RECEIVED');
                return;
            }

            const kind = remoteTrackCount > 0 ? 'board' : 'player';
            remoteTrackCount++;

            if (kind === 'player') window.__maxlowSenderRemoteStream = incoming;
            else window.__maxlowSenderRemoteBoardStream = incoming;

            window.dispatchEvent(new CustomEvent('maxlow-sender-remote-stream', {
                detail: { stream: incoming, kind }
            }));

            console.log(`SEND MY CAMERA: RETURN ${kind.toUpperCase()} CAMERA RECEIVED`);
        };

        peer.onicecandidate = e => {
            if (e.candidate) {
                send({ type:'ice', target, from:senderId, candidate:e.candidate.toJSON() });
            }
        };

        peer.onconnectionstatechange = () => {
            console.log('SEND MY CAMERA WebRTC:', peer?.connectionState);
            if (peer?.connectionState === 'connected') status.textContent = 'LIVE - CAMERA CONNECTED';
            if (peer?.connectionState === 'failed') status.textContent = 'CONNECTION LOST';
        };
    }

    async function flushIce() {
        if (!peer?.remoteDescription) return;
        while (pendingIce.length) {
            const candidate = pendingIce.shift();
            try { await peer.addIceCandidate(candidate); }
            catch (e) { console.warn('SEND MY CAMERA ICE flush failed', e); }
        }
    }

    function connectToPin(rawPin, status) {
        const pin = String(rawPin || '').replace(/\D/g,'').slice(0,6);

        if (pin.length !== 6) {
            status.textContent = 'ENTER THE 6 DIGIT PIN';
            return;
        }
        if (!localStream) {
            status.textContent = 'START CAMERA FIRST';
            return;
        }

        if (boardEnabled && !boardStream) {
            status.textContent = 'START / CHOOSE OCHE CAMERA FIRST';
            return;
        }
        if (audioEnabled && !microphoneStream) {
            status.textContent = 'START / CHOOSE MICROPHONE FIRST';
            return;
        }

        try { socket?.close(); } catch {}
        status.textContent = 'CONNECTING TO MAXLOW...';

        socket = new WebSocket(SIGNAL_URL);

        socket.onopen = () => {
            console.log('SEND MY CAMERA: signalling connected');
            status.textContent = 'PIN SENT - WAITING FOR PLAYER';
            send({ type:'join_pin', pin, id:senderId });
        };

        socket.onmessage = async event => {
            try {
                const data = JSON.parse(event.data);
                console.log('SEND MY CAMERA SIGNAL:', data.type, data);

                if (data.type === 'offer') {
                    const target = data.from || data.target;
                    status.textContent = 'PAIR FOUND - ESTABLISHING VIDEO';

                    await preparePeer(target, status);
                    await peer.setRemoteDescription(data.offer);
                    await flushIce();

                    const answer = await peer.createAnswer();
                    await peer.setLocalDescription(answer);

                    send({
                        type:'answer',
                        target,
                        from:senderId,
                        answer:peer.localDescription
                    });

                    status.textContent = 'ANSWER SENT - ESTABLISHING VIDEO';
                    console.log('SEND MY CAMERA: ANSWER SENT');
                    return;
                }

                if (data.type === 'ice' && data.candidate) {
                    if (!peer || !peer.remoteDescription) {
                        pendingIce.push(data.candidate);
                    } else {
                        await peer.addIceCandidate(data.candidate);
                    }
                }

                if (data.type === 'error') {
                    status.textContent = data.message || 'PIN / CONNECTION ERROR';
                }
            } catch (e) {
                console.error('SEND MY CAMERA signal error', e);
                status.textContent = 'CONNECTION ERROR';
            }
        };

        socket.onerror = e => {
            console.error('SEND MY CAMERA socket error', e);
            status.textContent = 'CANNOT REACH MAXLOW SERVER';
        };

        socket.onclose = () => console.log('SEND MY CAMERA: signalling closed');
    }

    function disconnectSender(status) {
        try { peer?.close(); } catch {}
        try { socket?.close(); } catch {}
        try { localStream?.getTracks().forEach(t => t.stop()); } catch {}
        try { boardStream?.getTracks().forEach(t => t.stop()); } catch {}
        try { microphoneStream?.getTracks().forEach(t => t.stop()); } catch {}

        peer = null;
        socket = null;
        localStream = null;
        boardStream = null;
        microphoneStream = null;
        if (typeof window.maxlowSetChatChannel === 'function') window.maxlowSetChatChannel(null);
        pendingIce = [];
        remoteTrackCount = 0;

        const preview = document.getElementById('maxlow-sender-preview');
        const boardPreview = document.getElementById('maxlow-sender-board-preview');
        if (preview) preview.srcObject = null;
        if (boardPreview) boardPreview.srcObject = null;

        status.textContent = 'DISCONNECTED - CAMERAS RELEASED';
    }

    function addButton() {
        if (document.getElementById('maxlow-open-sender')) return;

        const button = el('button', {
            id:'maxlow-open-sender',
            textContent:'PIN INPUT'
        });

        Object.assign(button.style, {
            position:'fixed', top:'12px', right:'12px', zIndex:'2147483000',
            padding:'8px 12px', border:'1px solid rgba(255,255,255,.25)',
            borderRadius:'6px', background:'rgba(0,0,0,.78)', color:'#fff',
            fontWeight:'800', fontSize:'12px', cursor:'pointer'
        });

        button.onclick = openSender;
        document.body.append(button);

        if (!document.getElementById('maxlow-chat-button')) {
            const chat = el('button', {
                id:'maxlow-chat-button',
                textContent:'CHAT'
            });
            Object.assign(chat.style, {
                position:'fixed', top:'12px', right:'104px', zIndex:'2147483000',
                padding:'8px 12px', border:'1px solid rgba(255,255,255,.25)',
                borderRadius:'3px', background:'#1558b0', color:'#fff',
                fontWeight:'900', fontSize:'12px', cursor:'pointer',
                boxShadow:'0 0 10px rgba(35,136,255,.25)'
            });
            chat.onclick = () => {
                if (typeof window.maxlowOpenChat === 'function') window.maxlowOpenChat();
            };
            document.body.append(chat);
        }
    }

    addButton();
    setInterval(addButton, 2000);
    console.log('MAXLOW UNIVERSAL SENDER MODULE LOADED');
})();
