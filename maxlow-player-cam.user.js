// ==UserScript==
// @name        Maxlow Player Cam
// @namespace    maxlow-designs
// @version      0.7.4
// @description Maxlow Designs two-way online Player Cam for Autodarts
// @match        https://play.autodarts.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const CAMERA_ID = 'maxlow-live-player-cam';
    const WRAPPER_ID = 'maxlow-live-player-cam-wrapper';
    const BUTTON_ID = 'maxlow-live-cam-button';
    const SETTINGS_ID = 'maxlow-live-cam-settings-button';
    const PANEL_ID = 'maxlow-live-cam-panel';

    let cameraStream = null;
    let cameraEnabled = true;

    // ONLINE MODE - public Maxlow signalling server
    const SIGNAL_URL = 'wss://maxlow-player-cam-server.onrender.com/ws';
    let onlineSocket = null;
    let onlinePeer = null;
    let remoteStream = null;
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
                 AUTODARTS BOTTOM BADGE
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

                AUTODARTS

            </div>


            <!-- RED BOTTOM ACCENT -->

            <div style="
                position:absolute;

                left:37%;
                bottom:5%;

                width:6%;
                height:3px;

                background:#ff1717;

                box-shadow:
                    0 0 7px #ff1717;

                z-index:11;
            "></div>


            <!-- BLUE BOTTOM ACCENT -->

            <div style="
                position:absolute;

                right:37%;
                bottom:5%;

                width:6%;
                height:3px;

                background:#168cff;

                box-shadow:
                    0 0 7px #168cff;

                z-index:11;
            "></div>

        `;

        wrapper.appendChild(frame);

        document.body.appendChild(wrapper);

        return video;
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

            console.log(
                'MAXLOW UNIVERSAL PLAYER CAM v0.7.4'
            );

        } catch (error) {

            console.error(
                'MAXLOW LIVE PLAYER CAM: Camera error',
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

                wrapper.style.right = '25px';
                wrapper.style.top = '60px';

                break;


            default:

                wrapper.style.right = '25px';
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

            settingsButton.textContent = '⚙';

            styleToolbarButton(settingsButton);

            settingsButton.style.padding =
                '0 8px';


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


            <label style="font-size:12px;">
                CAMERA
            </label>


            <select
                id="maxlow-camera-select"
                style="${selectStyle()}"
            >

                <option value="">
                    Default camera
                </option>

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


        sizeSelect.value =
            settings.size;


        positionSelect.value =
            settings.position;


        modeSelect.value =
            settings.mode;

        updatePinDisplay();


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

        const select =
            document.getElementById(
                'maxlow-camera-select'
            );


        if (!select) return;


        try {

            const devices =
                await navigator.mediaDevices
                    .enumerateDevices();


            const cameras =
                devices.filter(
                    device =>
                        device.kind === 'videoinput'
                );


            select.innerHTML =
                '<option value="">Default camera</option>';


            cameras.forEach(
                (camera, index) => {

                    const option =
                        document.createElement('option');


                    option.value =
                        camera.deviceId;


                    option.textContent =
                        camera.label ||
                        `Camera ${index + 1}`;


                    select.appendChild(option);
                }
            );


            select.value =
                settings.deviceId || '';


            select.onchange =
                async e => {

                    settings.deviceId =
                        e.target.value;

                    saveSettings();

                    await startCamera();
                };


        } catch (error) {

            console.error(
                'MAXLOW: Could not list cameras',
                error
            );
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
            wrapper.style.display = 'none';

            if (lastTurnState !== true) {
                console.log(
                    'MAXLOW: MY TURN - opponent camera hidden',
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
        remoteStream = stream;
        console.log('MAXLOW: TWO-WAY RETURN CAMERA ATTACHED');
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

        onlinePeer.ontrack = event => {
            console.log('MAXLOW: REMOTE TRACK RECEIVED');

            remoteStream =
                event.streams?.[0] ||
                new MediaStream([event.track]);

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
        pendingIce = [];
        onlineIdentity = null;
        lastTurnState = null;
    }

    function startOnlineMode() {
        if (settings.mode !== 'online') return;
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
    setInterval(() => {
        if (settings.mode !== 'online') return;

        const state = findMatchState();

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
    let pendingIce = [];
    let cameraId = localStorage.getItem('maxlowSenderCameraId') || '';
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
            width: 'min(92vw, 520px)', background: '#111827', color: '#fff',
            border: '1px solid #374151', borderRadius: '12px',
            padding: '22px', boxShadow: '0 20px 60px rgba(0,0,0,.55)'
        });

        const title = el('div', { textContent: 'MAXLOW DESIGNS' });
        Object.assign(title.style, { fontSize:'22px', fontWeight:'800', textAlign:'center' });

        const subtitle = el('div', { textContent: 'PLAYER CAMERA SENDER' });
        Object.assign(subtitle.style, { fontSize:'13px', textAlign:'center', opacity:'.75', margin:'4px 0 18px' });

        const pin = el('input', {
            id: 'maxlow-sender-pin', placeholder: '6 DIGIT PIN',
            inputMode: 'numeric', maxLength: 6
        });
        Object.assign(pin.style, {
            width:'100%', boxSizing:'border-box', padding:'13px',
            fontSize:'24px', letterSpacing:'8px', textAlign:'center',
            borderRadius:'7px', border:'1px solid #4b5563',
            background:'#030712', color:'#fff', outline:'none'
        });
        pin.addEventListener('input', () => pin.value = pin.value.replace(/\D/g,'').slice(0,6));

        const select = el('select', { id:'maxlow-sender-camera' });
        Object.assign(select.style, {
            width:'100%', boxSizing:'border-box', marginTop:'12px', padding:'10px',
            borderRadius:'7px', border:'1px solid #4b5563',
            background:'#030712', color:'#fff'
        });

        const preview = el('video', { id:'maxlow-sender-preview', autoplay:true, muted:true, playsInline:true });
        Object.assign(preview.style, {
            width:'100%', aspectRatio:'16/9', objectFit:'cover', background:'#000',
            borderRadius:'8px', marginTop:'12px'
        });

        const status = el('div', { id:'maxlow-sender-status', textContent:'Camera not started' });
        Object.assign(status.style, { textAlign:'center', margin:'12px 0', fontWeight:'700', fontSize:'13px' });

        const start = el('button', { textContent:'START / CHOOSE CAMERA' });
        const connect = el('button', { textContent:'CONNECT CAMERA' });
        const disconnect = el('button', { textContent:'DISCONNECT' });
        const close = el('button', { textContent:'CLOSE' });

        for (const b of [start, connect, disconnect, close]) {
            Object.assign(b.style, {
                width:'100%', padding:'11px', marginTop:'8px', border:'0',
                borderRadius:'7px', cursor:'pointer', fontWeight:'800'
            });
        }

        start.onclick = () => startCamera(select, preview, status);
        connect.onclick = () => connectToPin(pin.value, status);
        disconnect.onclick = () => disconnectSender(status);
        close.onclick = () => overlay.remove();

        panel.append(title, subtitle, pin, select, preview, status, start, connect, disconnect, close);
        overlay.append(panel);
        document.body.append(overlay);

        loadCameras(select).catch(console.warn);
    }

    async function loadCameras(select) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter(d => d.kind === 'videoinput');
        select.innerHTML = '';
        cams.forEach((cam, i) => {
            const option = el('option', {
                value: cam.deviceId,
                textContent: cam.label || `Camera ${i + 1}`
            });
            if (cam.deviceId === cameraId) option.selected = true;
            select.append(option);
        });
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

    function send(data) {
        if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(data));
        }
    }

    async function preparePeer(target, status) {
        try { peer?.close(); } catch {}
        peer = new RTCPeerConnection({ iceServers: STUN_SERVERS });
        pendingIce = [];

        if (!localStream) throw new Error('Start camera first');

        localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

        // Receive the PIN owner's camera back over this same connection.
        peer.ontrack = event => {
            const incoming =
                event.streams?.[0] ||
                new MediaStream([event.track]);

            window.__maxlowSenderRemoteStream = incoming;
            window.dispatchEvent(new CustomEvent('maxlow-sender-remote-stream', {
                detail: { stream: incoming }
            }));
            console.log('SEND MY CAMERA: RETURN CAMERA RECEIVED');
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
        peer = null;
        socket = null;
        pendingIce = [];
        status.textContent = 'DISCONNECTED';
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
    }

    addButton();
    setInterval(addButton, 2000);
    console.log('MAXLOW UNIVERSAL SENDER MODULE LOADED');
})();
