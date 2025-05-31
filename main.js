const promiseQueues = new WeakMap();

const CONTROL_BUTTONS = {
    pan: ['▶', '◀'],
    tilt: ['▼', '▲'],
    zoom: ['⇲', '⇱']
}

// Detects a long click (press ≥ threshold) vs. a short click
// `shortHandler` is called for a short click, `longHandler` for a long press.
function addClickHandlers(element, shortHandler, longHandler, threshold = 1000) {
    let downTime = 0;
    let timer;

    const onDown = () => {
        downTime = Date.now();
        timer = setTimeout(() => {
            longHandler?.();
            downTime = 0;
        }, threshold);
    };

    const onUp = () => {
        if (downTime === 0) return; // Ignore if not pressed down
        clearTimeout(timer);

        const duration = Date.now() - downTime;
        downTime = 0;

        if (duration < threshold) {
            shortHandler?.();
        } else {
            longHandler?.();
        }
    };

    element.addEventListener('mousedown', onDown);
    element.addEventListener('touchstart', onDown);
    ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(event => element.addEventListener(event, onUp));

    return () => {
        element.removeEventListener('mousedown', onDown);
        element.removeEventListener('touchstart', onDown);
        ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(event => element.removeEventListener(event, onUp));
    }
}

function applyToCamera(track, allValues) {
    if (promiseQueues.has(track)) return;

    const allSettled = Object.values(allValues).every(v => v.desiredValue === v.currentValue);
    if (allSettled) return;

    const allDesiredConstraints = Object.fromEntries(
        Object.entries(allValues).filter(([key, value]) => value.desiredValue !== value.currentValue).map(([key, value]) => [key, value.desiredValue])
    );
    promiseQueues.set(track, track.applyConstraints({ advanced: [allDesiredConstraints] }).then(() => {
        // Update current values after applying constraints
        Object.entries(allDesiredConstraints).forEach(([propName, value]) => {
            allValues[propName].currentValue = value;
            console.log(`Set ${propName} to ${value}`);
        });
        promiseQueues.delete(track);

        const allSettled = Object.values(allValues).every(v => v.desiredValue === v.currentValue);

        if (!allSettled) {
            applyToCamera(track, allValues);
        }
    }).catch(err => {
        console.error(`Error setting ${JSON.stringify(allDesiredConstraints)}:`, err);
        promiseQueues.delete(track);
    }));
}

async function initCameras() {
    try {
        const tempVideoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        tempVideoStream.getTracks().forEach(t => t.stop());
        const videoDevices = devices.filter(d => d.kind === 'videoinput');

        for (const device of videoDevices) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { width: 1280, aspectRatio: 16/9, deviceId: { exact: device.deviceId }, pan: true, tilt: true, zoom: true }
                });

                const videoEl = document.createElement('video');
                videoEl.srcObject = stream;
                videoEl.autoplay = true;

                const track = stream.getVideoTracks()[0];
                const capabilities = track.getCapabilities();

                let hasPTZ = false;
                if (capabilities.pan !== undefined ||
                    capabilities.tilt !== undefined ||
                    capabilities.zoom !== undefined) {
                    hasPTZ = true;
                }

                const container = document.createElement('div');
                container.className = 'camera-block';
                container.appendChild(videoEl);

                if (hasPTZ) {
                    const controls = createPTZControls(track);
                    container.appendChild(controls);
                }

                document.getElementById('cameras').appendChild(container);
            } catch (err) {
                console.error(`Error accessing camera ${device.label}:`, err);
            }
        }
    } catch (err) {
        console.error("Error enumerating devices:", err);
    }
}

function repeatCbWhileMousePressed(cb, element, delay = 50) {
    let intervalId;
    let isMouseDown = false;

    element.addEventListener('mousedown', () => {
        isMouseDown = true;
        intervalId = setInterval(() => {
            if (isMouseDown) cb();
        }, delay);
    });

    element.addEventListener('mouseup', () => {
        isMouseDown = false;
        clearInterval(intervalId);
    });

    element.addEventListener('mouseleave', () => {
        isMouseDown = false;
        clearInterval(intervalId);
    });
}

// Constant for a gamepad input threshold
const GAMEPAD_INPUT_THRESHOLD = 0.1;

function createPTZControls(track) {
    const container = document.createElement('div');
    container.className = 'controls';
    const capabilities = track.getCapabilities();
    const initialSettings = track.getSettings();
    console.log("Initial Settings:", initialSettings);
    console.log("Capabilities:", capabilities);

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    const allowedProps = ['pan', 'tilt', 'zoom'].filter(p => capabilities[p] !== undefined);
    const presets = allowedProps.length > 0 ? [{}, {}, {}] : [];
    const allValues = Object.fromEntries(
        allowedProps.map(prop => {
            const initialValue = initialSettings[prop] ?? 0;
            presets[0][prop] = initialValue;
            const { step, min, max } = capabilities[prop] ?? { step: 1, min: 0, max: 100 };

            return [prop, { initialValue, currentValue: initialValue, desiredValue: initialValue, step, min, max }]
        })
    );

    // Gamepad state
    let gamepadLoopActive = false;

    function createControls(propName) {
        const leftBtn = document.createElement('button');
        leftBtn.textContent = CONTROL_BUTTONS[propName][0];
        leftBtn.className = `${propName}-minus`;
        const rightBtn = document.createElement('button');
        rightBtn.textContent = CONTROL_BUTTONS[propName][1];
        rightBtn.className = `${propName}-plus`;

        const makeClickHandler = d => async function clickHandler() {
            const v = allValues[propName];
            v.desiredValue = clamp(v.desiredValue + d * v.step, v.min, v.max);
            applyToCamera(track, allValues);
        }

        repeatCbWhileMousePressed(makeClickHandler(-1), leftBtn);
        repeatCbWhileMousePressed(makeClickHandler(1), rightBtn);
        const span = document.createElement('span');
        span.appendChild(leftBtn);
        span.appendChild(rightBtn);
        container.appendChild(span);
    }

    allowedProps.forEach(createControls);


    if (allowedProps.length > 0) {
        const resetSpan = document.createElement('span');

        for (let i = 1; i <= 3 ; i++) {
            const presetBtn = document.createElement('button');
            presetBtn.textContent = String(i);
            presetBtn.className = `preset-ptz-${i}`;
            addClickHandlers(presetBtn, () => {
                allowedProps.forEach(propName => {
                    const v = allValues[propName];
                    v.desiredValue = presets[i - 1][propName] ?? 0;
                });
                applyToCamera(track, allValues);
            }, () => {
                // Save current values as preset
                allowedProps.forEach(propName => {
                    presets[i - 1][propName] = allValues[propName].currentValue;
                });
                console.log(`Preset ${i} saved:`, presets[i - 1]);

                // Blink the button to signal preset was saved
                presetBtn.classList.add('inversed');
                setTimeout(() => {
                    presetBtn.classList.remove('inversed');
                }, 300);
            });
            resetSpan.appendChild(presetBtn);
        }

        const resetBtn = document.createElement('button');
        resetBtn.textContent = '•';
        resetBtn.className = 'reset-ptz';
        resetBtn.onclick = () => {
            allowedProps.forEach(propName => {
                const v = allValues[propName];
                v.desiredValue = 0;
            });
            applyToCamera(track, allValues);
        };
        resetSpan.appendChild(resetBtn);
        container.appendChild(resetSpan);
    }

    // Gamepad support implementation
    function initGamepadSupport() {
        if (gamepadLoopActive) return;

        window.addEventListener("gamepadconnected", (e) => {
            console.log("Gamepad connected:", e.gamepad.id);
            if (!gamepadLoopActive) {
                gamepadLoopActive = true;
                requestAnimationFrame(pollGamepad);
            }
        });

        window.addEventListener("gamepaddisconnected", (e) => {
            console.log("Gamepad disconnected:", e.gamepad.id);
            // Check if there are any gamepads still connected
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
            let hasConnectedGamepad = false;
            for (let i = 0; i < gamepads.length; i++) {
                if (gamepads[i]) {
                    hasConnectedGamepad = true;
                    break;
                }
            }
            if (!hasConnectedGamepad) {
                gamepadLoopActive = false;
            }
        });

        // Check if a gamepad is already connected
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let i = 0; i < gamepads.length; i++) {
            if (gamepads[i]) {
                console.log("Gamepad already connected:", gamepads[i].id);
                gamepadLoopActive = true;
                requestAnimationFrame(pollGamepad);
                break;
            }
        }
    }

    function pollGamepad() {
        if (!gamepadLoopActive) return;

        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        let gamepad = null;

        // Find the first connected gamepad
        for (let i = 0; i < gamepads.length; i++) {
            if (gamepads[i]) {
                gamepad = gamepads[i];
                break;
            }
        }

        if (gamepad) {
            // Left stick for pan and tilt
            const leftStickX = gamepad.axes[0]; // Pan (left/right)
            const leftStickY = gamepad.axes[1]; // Tilt (up/down)

            // Triggers for zoom
            const leftTrigger = gamepad.buttons[6].value; // Zoom out
            const rightTrigger = gamepad.buttons[7].value; // Zoom in

            let changed = false;

            function applyGamepadInput(value, input, log) {
                if (!value) return false;

                if (Math.abs(input) > GAMEPAD_INPUT_THRESHOLD) {
                    const delta = clamp(Math.abs(input), 1, 2) * Math.sign(input);
                    console.log(`Gamepad ${log} input ${input}: ${delta}`);
                    value.desiredValue = clamp(value.desiredValue + delta * value.step, value.min, value.max);

                    return true;
                }

                return false;
            }

            changed = applyGamepadInput(allValues.pan, -leftStickX, 'X') || changed;
            // Note: Y-axis is inverted for tilt, so we use -leftStickY
            changed = applyGamepadInput(allValues.tilt, -leftStickY, 'Y') || changed;
            changed = applyGamepadInput(allValues.zoom, rightTrigger, 'RT') || changed;
            changed = applyGamepadInput(allValues.zoom, -leftTrigger, 'LT') || changed;

            // Apply changes to camera if needed
            if (changed) {
                // Log gamepad values for debugging
                console.log("Gamepad inputs:", {
                    leftStickX,
                    leftStickY,
                    leftTrigger,
                    rightTrigger
                });
                applyToCamera(track, allValues);
            }
        }

        // Continue polling
        if (gamepadLoopActive) {
            requestAnimationFrame(pollGamepad);
        }
    }

    // Initialize gamepad support
    initGamepadSupport();

    return container;
}

// Start the camera initialization
document.getElementById('start').onclick = () => {
    document.getElementById('cameras').innerHTML = ''; // Clear previous cameras
    initCameras();
};
