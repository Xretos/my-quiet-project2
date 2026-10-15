<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>声波高速数据接收端 (QPSK-64k)</title>
    
    <!-- 必须引入真实的 quiet.js 核心库 (需下载到本地同一目录) -->
    <script src="quiet-emscripten.js"></script>
    <script src="quiet.js"></script>
    
    <style>
        body { font-family: -apple-system, sans-serif; padding: 20px; background: #f0f2f5; color: #333; }
        .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width: 500px; margin: 0 auto; }
        button { background: #007bff; color: white; border: none; padding: 12px 24px; border-radius: 6px; font-size: 16px; width: 100%; cursor: pointer; }
        button:disabled { background: #ccc; }
        .stats { display: flex; justify-content: space-between; margin-top: 20px; font-size: 14px; color: #666; }
        .progress-bar { height: 10px; background: #e9ecef; border-radius: 5px; margin-top: 15px; overflow: hidden; }
        .progress-fill { height: 100%; background: #28a745; width: 0%; transition: width 0.2s; }
        #log { margin-top: 15px; font-size: 12px; color: #999; max-height: 100px; overflow-y: auto; }
    </style>
</head>
<body>

<div class="card">
    <h2 style="margin-top: 0;">声波接收终端</h2>
    <button id="btnStart" onclick="startListening()">允许麦克风并启动接收</button>
    
    <div class="stats">
        <span id="txtSpeed">速率: 0 kbps</span>
        <span id="txtErrors">CRC错帧: 0</span>
    </div>
    
    <div class="progress-bar">
        <div id="progFill" class="progress-fill"></div>
    </div>
    <div style="text-align: center; font-size: 14px; margin-top: 8px;" id="txtProgress">等待握手 (0 / 0 KB)</div>
    
    <div id="log"></div>
</div>

<script>
    const crc32Table = new Uint32Array(256);
    for(let i=0; i<256; i++){
        let c = i;
        for(let j=0; j<8; j++){ c = ((c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1)); }
        crc32Table[i] = c;
    }
    function calcCrc32(uint8Arr) {
        let crc = 0xFFFFFFFF;
        for(let i=0; i<uint8Arr.length; i++) {
            crc = (crc >>> 8) ^ crc32Table[(crc ^ uint8Arr[i]) & 0xFF];
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    const STATE_WAIT_HEADER = 0;
    const STATE_RECEIVING = 1;
    let currentState = STATE_WAIT_HEADER;
    
    let fileMeta = { name: "", size: 0, totalChunks: 0, globalCrc: 0 };
    let fileBuffer = null;
    let receivedChunks = new Set();
    let errorCount = 0;
    let byteCounter = 0;
    let lastTime = Date.now();

    const btn = document.getElementById('btnStart');
    const logEl = document.getElementById('log');
    const txtSpeed = document.getElementById('txtSpeed');
    const txtErrors = document.getElementById('txtErrors');
    const txtProgress = document.getElementById('txtProgress');
    const progFill = document.getElementById('progFill');

    function log(msg) {
        logEl.innerHTML += `<div>${new Date().toLocaleTimeString()} - ${msg}</div>`;
        logEl.scrollTop = logEl.scrollHeight;
    }

    setInterval(() => {
        if(currentState === STATE_RECEIVING) {
            let now = Date.now();
            let dt = (now - lastTime) / 1000;
            let kbps = ((byteCounter * 8) / 1024 / dt).toFixed(1);
            txtSpeed.innerText = `速率: ${kbps} kbps`;
            byteCounter = 0;
            lastTime = now;
        }
    }, 1000);

    function onReceive(recvPayload) {
        let buffer = recvPayload.buffer;
        let dataView = new DataView(buffer);
        
        if (currentState === STATE_WAIT_HEADER) {
            if (recvPayload.length >= 78 && dataView.getUint32(0, false) === 0xDEADBEEF) {
                let nameArr = recvPayload.slice(4, 68);
                fileMeta.name = new TextDecoder().decode(nameArr).replace(/\0/g, '');
                fileMeta.size = dataView.getUint32(68, false);
                fileMeta.totalChunks = dataView.getUint16(72, false);
                fileMeta.globalCrc = dataView.getUint32(74, false);
                
                fileBuffer = new Uint8Array(fileMeta.size);
                currentState = STATE_RECEIVING;
                lastTime = Date.now();
                byteCounter = 0;
                
                log(`[元数据] ${fileMeta.name}, 大小:${fileMeta.size}B, 块数:${fileMeta.totalChunks}`);
            }
        } 
        else if (currentState === STATE_RECEIVING) {
            if (recvPayload.length === 1030) {
                let seq = dataView.getUint16(0, false);
                let payload = recvPayload.slice(2, 1026);
                let recvCrc = dataView.getUint32(1026, false);
                
                if (calcCrc32(payload) === recvCrc) {
                    if (!receivedChunks.has(seq)) {
                        let offset = seq * 1024;
                        let lengthToCopy = Math.min(1024, fileMeta.size - offset);
                        fileBuffer.set(payload.slice(0, lengthToCopy), offset);
                    
