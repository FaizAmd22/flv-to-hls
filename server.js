const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

const config = {
    maxConcurrentStreams: parseInt(process.env.MAX_STREAMS || '20'),
    segmentDuration: parseInt(process.env.SEGMENT_DURATION || '2'),
    maxSegments: parseInt(process.env.MAX_SEGMENTS || '10'),
    streamTimeout: parseInt(process.env.STREAM_TIMEOUT || '600000'),
    cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL || '30000'),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
    retryDelay: parseInt(process.env.RETRY_DELAY || '2000')
};

app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

const rateLimitMap = new Map();
const rateLimit = (req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = 50;

    if (!rateLimitMap.has(clientIP)) {
        rateLimitMap.set(clientIP, { count: 1, resetTime: now + windowMs });
        return next();
    }

    const clientData = rateLimitMap.get(clientIP);
    if (now > clientData.resetTime) {
        clientData.count = 1;
        clientData.resetTime = now + windowMs;
        return next();
    }

    if (clientData.count >= maxRequests) {
        return res.status(429).json({
            success: false,
            message: 'Too many requests. Please try again later.',
            retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
        });
    }

    clientData.count++;
    next();
};

app.use(rateLimit);

app.use('/hls', (req, res, next) => {
    if (req.path.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    } else if (req.path.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Cache-Control', 'public, max-age=3600');
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Accept-Ranges', 'bytes');
    next();
}, express.static('hls'));

const activeStreams = new Map();
const streamMetrics = new Map();

const hlsDir = path.join(__dirname, 'hls');
if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
}

const isValidUrl = (string) => {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'rtmp:' || url.protocol === 'rtsp:';
    } catch (_) {
        return false;
    }
};

const generateSafeStreamId = (inputId) => {
    return inputId.replace(/[^a-zA-Z0-9_-]/g, '_');
};

const checkFFmpegHealth = () => {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
        let resolved = false;
        
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(false);
            }
        }, 5000);

        ffmpeg.on('close', (code) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(code === 0);
            }
        });

        ffmpeg.on('error', () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(false);
            }
        });
    });
};

const waitForPlaylist = (playlistPath, timeout = 45000) => {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const checkPlaylist = () => {
            if (fs.existsSync(playlistPath)) {
                try {
                    const content = fs.readFileSync(playlistPath, 'utf8');
                    if (content.includes('#EXTM3U')) {
                        const segments = content.match(/\.ts/g);
                        if (segments && segments.length > 0) {
                            resolve(true);
                            return;
                        }
                    }
                } catch (error) {
                    console.log("error :", error);
                }
            }
            
            if (Date.now() - startTime > timeout) {
                reject(new Error('Timeout waiting for playlist'));
                return;
            }
            
            setTimeout(checkPlaylist, 1500);
        };
        checkPlaylist();
    });
};

const cleanupStreamDirectory = (streamId) => {
    const streamDir = path.join(hlsDir, streamId);
    
    setTimeout(() => {
        try {
            if (fs.existsSync(streamDir)) {
                const files = fs.readdirSync(streamDir);
                for (const file of files) {
                    try {
                        fs.unlinkSync(path.join(streamDir, file));
                    } catch (fileError) {
                        console.warn(`Warning: Could not delete file ${file}:`, fileError.message);
                    }
                }
                
                fs.rmdirSync(streamDir);
                console.log(`🧹 Cleaned up directory for stream ${streamId}`);
            }
        } catch (error) {
            console.error(`❌ Error cleaning up stream directory ${streamId}:`, error);
        }
    }, 5000);
};

const createFFmpegProcess = (flvUrl, streamDir, safeStreamId) => {
    const ffmpegArgs = [
        '-hide_banner',                        // Hide FFmpeg banner
        '-loglevel', 'info',                   // Set log level
        '-reconnect', '1',                     // Auto reconnect if connection lost
        '-reconnect_streamed', '1',            // Reconnect for streamed inputs
        '-reconnect_delay_max', '5',           // Max delay 5 seconds
        '-reconnect_at_eof', '1',              // Reconnect at end of file
        '-timeout', '10000000',                // 10 second timeout for network operations
        '-i', flvUrl,                          // Input FLV stream
        '-c:v', 'libx264',                     // Video codec H.264
        '-c:a', 'aac',                         // Audio codec AAC
        '-preset', 'ultrafast',                // Fast encoding
        '-tune', 'zerolatency',                // Low latency
        '-profile:v', 'baseline',              // iOS compatibility
        '-level', '3.0',                       // iOS compatibility
        '-pix_fmt', 'yuv420p',                 // iOS compatibility
        '-r', '25',                            // Frame rate
        '-g', '50',                            // Keyframe interval (2 seconds at 25fps)
        '-keyint_min', '25',                   // Minimum keyframe interval
        '-sc_threshold', '0',                  // Disable scene change detection
        '-b:v', '1000k',                       // Video bitrate
        '-maxrate', '1200k',                   // Max video bitrate
        '-bufsize', '2000k',                   // Buffer size
        '-b:a', '128k',                        // Audio bitrate
        '-ar', '44100',                        // Audio sample rate
        '-ac', '2',                            // Audio channels
        '-f', 'hls',                           // Output format HLS
        '-hls_time', config.segmentDuration.toString(),
        '-hls_list_size', config.maxSegments.toString(),
        '-hls_flags', 'delete_segments+append_list+split_by_time+independent_segments',
        '-hls_allow_cache', '0',
        '-hls_segment_type', 'mpegts',         // Segment type
        '-hls_segment_filename', path.join(streamDir, 'segment_%05d.ts'),
        '-method', 'PUT',                      // HTTP method for segments
        '-y',                                  // Overwrite output files
        path.join(streamDir, 'playlist.m3u8')
    ];

    return spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FFREPORT: 'file=ffmpeg.log:level=32' }
    });
};

app.post('/api/stream/start', async (req, res) => {
    let safeStreamId = null;
    
    try {
        const { flvUrl, streamId } = req.body;

        if (!flvUrl || !streamId) {
            return res.status(400).json({
                success: false,
                message: 'flvUrl and streamId are required'
            });
        }

        if (!isValidUrl(flvUrl)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid flvUrl format'
            });
        }

        safeStreamId = generateSafeStreamId(streamId);

        if (activeStreams.size >= config.maxConcurrentStreams) {
            return res.status(429).json({
                success: false,
                message: `Maximum concurrent streams limit reached (${config.maxConcurrentStreams})`,
                activeStreams: activeStreams.size,
                maxStreams: config.maxConcurrentStreams
            });
        }

        if (activeStreams.has(safeStreamId)) {
            const stream = activeStreams.get(safeStreamId);
            
            if (!stream.process.killed) {
                return res.json({
                    success: true,
                    message: 'Stream already active',
                    hlsUrl: `http://localhost:${PORT}/hls/${safeStreamId}/playlist.m3u8`,
                    streamId: safeStreamId,
                    startTime: stream.startTime,
                    uptime: Date.now() - stream.startTime,
                    status: 'active'
                });
            } else {
                activeStreams.delete(safeStreamId);
                streamMetrics.delete(safeStreamId);
            }
        }

        const streamDir = path.join(hlsDir, safeStreamId);
        if (!fs.existsSync(streamDir)) {
            fs.mkdirSync(streamDir, { recursive: true });
        }

        console.log(`🚀 Starting FFmpeg for stream ${safeStreamId}`);
        console.log(`📹 Input: ${flvUrl}`);
        console.log(`📂 Output: ${streamDir}`);

        const ffmpeg = createFFmpegProcess(flvUrl, streamDir, safeStreamId);

        let ffmpegReady = false;
        let errorOccurred = false;
        let lastErrorMessage = '';

        streamMetrics.set(safeStreamId, {
            startTime: Date.now(),
            reconnectCount: 0,
            errorCount: 0,
            lastError: null,
            segmentCount: 0,
            lastSegmentTime: null
        });

        ffmpeg.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`📺 FFmpeg stdout [${safeStreamId}]:`, output.trim());
            
            if (output.includes('muxer does not support non seekable output') || 
                output.includes('Opening \'') ||
                output.includes('hls muxer')) {
                ffmpegReady = true;
            }
        });

        ffmpeg.stderr.on('data', (data) => {
            const output = data.toString();
            console.log(`🔧 FFmpeg stderr [${safeStreamId}]:`, output.trim());
            
            const metrics = streamMetrics.get(safeStreamId);
            if (metrics) {
                if (output.includes('Opening') || 
                    output.includes('Stream #0') || 
                    output.includes('Output #0') ||
                    output.includes('hls @')) {
                    ffmpegReady = true;
                }
                
                if (output.includes('reconnect')) {
                    metrics.reconnectCount++;
                    console.log(`🔄 Reconnect count for ${safeStreamId}: ${metrics.reconnectCount}`);
                }
                
                if (output.includes('error') || output.includes('failed') || output.includes('Cannot')) {
                    metrics.errorCount++;
                    metrics.lastError = output.trim();
                    lastErrorMessage = output.trim();
                    
                    if (output.includes('Connection refused') || 
                        output.includes('No route to host') ||
                        output.includes('Invalid data found') ||
                        output.includes('Server returned 404 Not Found') ||
                        output.includes('HTTP error 404') ||
                        metrics.errorCount > 10) {
                        errorOccurred = true;
                    }
                }
                
                if (output.includes('.ts') || output.includes('segment')) {
                    metrics.segmentCount++;
                    metrics.lastSegmentTime = Date.now();
                }
            }
        });

        ffmpeg.on('close', (code) => {
            console.log(`⛔ FFmpeg process [${safeStreamId}] exited with code ${code}`);
            activeStreams.delete(safeStreamId);
            
            const metrics = streamMetrics.get(safeStreamId);
            if (metrics) {
                console.log(`📊 Final metrics for ${safeStreamId}:`, {
                    uptime: Date.now() - metrics.startTime,
                    reconnects: metrics.reconnectCount,
                    errors: metrics.errorCount,
                    segments: metrics.segmentCount
                });
            }
            
            cleanupStreamDirectory(safeStreamId);
        });

        ffmpeg.on('error', (error) => {
            console.error(`❌ FFmpeg error [${safeStreamId}]:`, error);
            activeStreams.delete(safeStreamId);
            
            const metrics = streamMetrics.get(safeStreamId);
            if (metrics) {
                metrics.errorCount++;
                metrics.lastError = error.message;
            }
            
            errorOccurred = true;
            lastErrorMessage = error.message;
        });

        const streamData = {
            process: ffmpeg,
            startTime: Date.now(),
            flvUrl: flvUrl,
            lastActivity: Date.now(),
            clientIP: req.ip || req.connection.remoteAddress,
            userAgent: req.get('User-Agent') || 'Unknown',
            timeout: setTimeout(() => {
                console.log(`⏰ Stream ${safeStreamId} timed out, stopping...`);
                try {
                    if (!ffmpeg.killed) {
                        ffmpeg.kill('SIGTERM');
                        
                        setTimeout(() => {
                            if (!ffmpeg.killed) {
                                ffmpeg.kill('SIGKILL');
                            }
                        }, 5000);
                    }
                } catch (error) {
                    console.error(`Error killing timed out stream ${safeStreamId}:`, error);
                }
            }, config.streamTimeout)
        };

        activeStreams.set(safeStreamId, streamData);

        const playlistPath = path.join(streamDir, 'playlist.m3u8');
        
        try {
            console.log(`⏳ Waiting for HLS playlist for stream ${safeStreamId}...`);
            await waitForPlaylist(playlistPath, 30000);
            console.log(`✅ HLS playlist ready for stream ${safeStreamId}`);
        } catch (waitError) {
            console.warn(`⚠️ Playlist not ready yet for ${safeStreamId}: ${waitError.message}`);
            
            if (errorOccurred) {
                if (activeStreams.has(safeStreamId)) {
                    const stream = activeStreams.get(safeStreamId);
                    if (stream.timeout) clearTimeout(stream.timeout);
                    if (!stream.process.killed) {
                        stream.process.kill('SIGTERM');
                    }
                    activeStreams.delete(safeStreamId);
                }
                
                cleanupStreamDirectory(safeStreamId);
                
                return res.status(500).json({
                    success: false,
                    message: 'Failed to start FFmpeg process',
                    error: lastErrorMessage || 'Stream source might be unavailable',
                    details: 'Critical error occurred during stream initialization'
                });
            }
        }

        if (errorOccurred || ffmpeg.killed) {
            activeStreams.delete(safeStreamId);
            cleanupStreamDirectory(safeStreamId);
            
            return res.status(500).json({
                success: false,
                message: 'Failed to start FFmpeg process',
                error: lastErrorMessage || 'Stream source might be unavailable',
                details: 'Process died during startup'
            });
        }

        const hlsUrl = `http://localhost:${PORT}/hls/${safeStreamId}/playlist.m3u8`;

        res.json({
            success: true,
            message: 'Stream conversion started successfully',
            hlsUrl: hlsUrl,
            streamId: safeStreamId,
            startTime: streamData.startTime,
            config: {
                segmentDuration: config.segmentDuration,
                maxSegments: config.maxSegments,
                timeout: config.streamTimeout
            },
            status: 'starting'
        });

    } catch (error) {
        console.error('❌ Error starting stream:', error);
        
        if (safeStreamId) {
            if (activeStreams.has(safeStreamId)) {
                const stream = activeStreams.get(safeStreamId);
                if (stream.timeout) clearTimeout(stream.timeout);
                if (stream.process && !stream.process.killed) {
                    stream.process.kill('SIGTERM');
                }
                activeStreams.delete(safeStreamId);
            }
            cleanupStreamDirectory(safeStreamId);
        }
        
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

app.post('/api/stream/stop', (req, res) => {
    try {
        const { streamId } = req.body;

        if (!streamId) {
            return res.status(400).json({
                success: false,
                message: 'streamId is required'
            });
        }

        const safeStreamId = generateSafeStreamId(streamId);
        const stream = activeStreams.get(safeStreamId);
        
        if (!stream) {
            return res.json({
                success: true,
                message: 'Stream not found or already stopped',
                streamId: safeStreamId
            });
        }

        if (stream.timeout) {
            clearTimeout(stream.timeout);
        }

        const metrics = streamMetrics.get(safeStreamId);
        const finalMetrics = metrics ? {
            uptime: Date.now() - metrics.startTime,
            reconnects: metrics.reconnectCount,
            errors: metrics.errorCount,
            segments: metrics.segmentCount
        } : null;

        try {
            if (!stream.process.killed) {
                stream.process.kill('SIGTERM');
                
                setTimeout(() => {
                    if (!stream.process.killed) {
                        console.warn(`Force killing stream ${safeStreamId}`);
                        stream.process.kill('SIGKILL');
                    }
                }, 5000);
            }
        } catch (killError) {
            console.error(`Error killing process for stream ${safeStreamId}:`, killError);
        }

        activeStreams.delete(safeStreamId);
        streamMetrics.delete(safeStreamId);

        cleanupStreamDirectory(safeStreamId);

        console.log(`🛑 Stream ${safeStreamId} stopped manually`);

        res.json({
            success: true,
            message: 'Stream stopped successfully',
            streamId: safeStreamId,
            stoppedAt: new Date().toISOString(),
            metrics: finalMetrics
        });

    } catch (error) {
        console.error('❌ Error stopping stream:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

app.get('/api/stream/status/:streamId', (req, res) => {
    const safeStreamId = generateSafeStreamId(req.params.streamId);
    const stream = activeStreams.get(safeStreamId);
    const metrics = streamMetrics.get(safeStreamId);

    if (!stream) {
        return res.json({
            success: true,
            active: false,
            message: 'Stream not active',
            streamId: safeStreamId
        });
    }

    const playlistPath = path.join(hlsDir, safeStreamId, 'playlist.m3u8');
    const playlistExists = fs.existsSync(playlistPath);
    
    let segmentCount = 0;
    let playlistContent = '';
    
    if (playlistExists) {
        try {
            playlistContent = fs.readFileSync(playlistPath, 'utf8');
            segmentCount = (playlistContent.match(/\.ts/g) || []).length;
        } catch (error) {
            console.error('Error reading playlist:', error);
        }
    }

    stream.lastActivity = Date.now();

    const streamDir = path.join(hlsDir, safeStreamId);
    let actualSegmentCount = 0;
    if (fs.existsSync(streamDir)) {
        try {
            const files = fs.readdirSync(streamDir);
            actualSegmentCount = files.filter(f => f.endsWith('.ts')).length;
        } catch (error) {
            console.error('Error reading stream directory:', error);
        }
    }

    res.json({
        success: true,
        active: true,
        streamId: safeStreamId,
        playlistExists: playlistExists,
        segmentCount: segmentCount,
        actualSegmentCount: actualSegmentCount,
        startTime: stream.startTime,
        uptime: Date.now() - stream.startTime,
        lastActivity: stream.lastActivity,
        hlsUrl: `http://localhost:${PORT}/hls/${safeStreamId}/playlist.m3u8`,
        processRunning: !stream.process.killed,
        flvUrl: stream.flvUrl,
        clientInfo: {
            ip: stream.clientIP,
            userAgent: stream.userAgent
        },
        metrics: metrics ? {
            reconnectCount: metrics.reconnectCount,
            errorCount: metrics.errorCount,
            segmentCount: metrics.segmentCount,
            lastError: metrics.lastError,
            lastSegmentTime: metrics.lastSegmentTime
        } : null
    });
});

app.get('/api/streams/active', (req, res) => {
    const streams = Array.from(activeStreams.entries()).map(([streamId, stream]) => {
        const metrics = streamMetrics.get(streamId);
        return {
            streamId,
            startTime: stream.startTime,
            uptime: Date.now() - stream.startTime,
            lastActivity: stream.lastActivity,
            flvUrl: stream.flvUrl,
            processRunning: !stream.process.killed,
            clientInfo: {
                ip: stream.clientIP,
                userAgent: stream.userAgent
            },
            metrics: metrics ? {
                reconnectCount: metrics.reconnectCount,
                errorCount: metrics.errorCount,
                segmentCount: metrics.segmentCount,
                lastError: metrics.lastError
            } : null
        };
    });

    res.json({
        success: true,
        activeStreams: streams.length,
        maxStreams: config.maxConcurrentStreams,
        utilizationPercent: Math.round((streams.length / config.maxConcurrentStreams) * 100),
        streams: streams,
        serverMetrics: {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            cpuUsage: process.cpuUsage()
        }
    });
});

app.get('/api/health', async (req, res) => {
    const ffmpegAvailable = await checkFFmpegHealth();
    
    let totalSegments = 0;
    for (const [streamId, metrics] of streamMetrics.entries()) {
        totalSegments += metrics.segmentCount;
    }
    
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        status: 'healthy',
        activeStreams: activeStreams.size,
        maxStreams: config.maxConcurrentStreams,
        utilizationPercent: Math.round((activeStreams.size / config.maxConcurrentStreams) * 100),
        ffmpegAvailable: ffmpegAvailable,
        config: config,
        serverMetrics: {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            cpuUsage: process.cpuUsage(),
            totalSegments: totalSegments
        },
        rateLimitStatus: {
            activeIPs: rateLimitMap.size
        }
    });
});

const periodicCleanup = () => {
    const now = Date.now();
    const inactiveStreams = [];

    console.log(`🧹 Running periodic cleanup... Active streams: ${activeStreams.size}`);

    for (const [streamId, stream] of activeStreams.entries()) {
        const metrics = streamMetrics.get(streamId);
        const uptime = now - stream.startTime;
        const inactiveTime = now - stream.lastActivity;
        
        let shouldCleanup = false;
        let reason = '';
        
        if (stream.process.killed) {
            shouldCleanup = true;
            reason = 'process killed';
        } else if (inactiveTime > config.streamTimeout) {
            shouldCleanup = true;
            reason = 'inactive timeout';
        } else if (metrics && metrics.errorCount > 20) {
            shouldCleanup = true;
            reason = 'too many errors';
        } else if (uptime > (24 * 60 * 60 * 1000)) { 
            shouldCleanup = true;
            reason = 'max uptime reached';
        }
        
        if (shouldCleanup) {
            console.log(`🧹 Marking stream ${streamId} for cleanup: ${reason}`);
            inactiveStreams.push({ streamId, reason });
        }
    }

    for (const { streamId, reason } of inactiveStreams) {
        const stream = activeStreams.get(streamId);
        const metrics = streamMetrics.get(streamId);
        
        if (stream) {
            console.log(`🧹 Cleaning up stream ${streamId} (${reason})`);
            
            if (metrics) {
                console.log(`📊 Final metrics for ${streamId}:`, {
                    uptime: Date.now() - metrics.startTime,
                    reconnects: metrics.reconnectCount,
                    errors: metrics.errorCount,
                    segments: metrics.segmentCount,
                    reason: reason
                });
            }
            
            if (stream.timeout) clearTimeout(stream.timeout);
            
            if (!stream.process.killed) {
                try {
                    stream.process.kill('SIGTERM');
                    setTimeout(() => {
                        if (!stream.process.killed) {
                            stream.process.kill('SIGKILL');
                        }
                    }, 3000);
                } catch (error) {
                    console.error(`Error killing inactive stream ${streamId}:`, error);
                }
            }
            
            activeStreams.delete(streamId);
            streamMetrics.delete(streamId);
        }

        cleanupStreamDirectory(streamId);
    }

    const rateLimit30MinAgo = now - (30 * 60 * 1000);
    let clearedRateLimitEntries = 0;
    
    for (const [ip, data] of rateLimitMap.entries()) {
        if (data.resetTime < rateLimit30MinAgo) {
            rateLimitMap.delete(ip);
            clearedRateLimitEntries++;
        }
    }
    
    if (clearedRateLimitEntries > 0) {
        console.log(`🧹 Cleared ${clearedRateLimitEntries} old rate limit entries`);
    }

    try {
        const hlsContents = fs.readdirSync(hlsDir);
        const activeDirs = new Set(Array.from(activeStreams.keys()));
        
        for (const item of hlsContents) {
            const itemPath = path.join(hlsDir, item);
            const stat = fs.statSync(itemPath);
            
            if (stat.isDirectory() && !activeDirs.has(item)) {
                const ageMs = now - stat.mtime.getTime();
                if (ageMs > 10 * 60 * 1000) {
                    try {
                        fs.rmSync(itemPath, { recursive: true, force: true });
                        console.log(`🧹 Removed orphaned directory: ${item}`);
                    } catch (error) {
                        console.warn(`Warning: Could not remove orphaned directory ${item}:`, error.message);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error during orphaned directory cleanup:', error);
    }
    
    console.log(`✅ Cleanup completed. Active streams: ${activeStreams.size}, Rate limit entries: ${rateLimitMap.size}`);
};

setInterval(periodicCleanup, config.cleanupInterval);

const cleanup = () => {
    console.log('🛑 Shutting down server, cleaning up active streams...');
    
    for (const [streamId, stream] of activeStreams.entries()) {
        try {
            if (stream.timeout) clearTimeout(stream.timeout);
            if (!stream.process.killed) {
                stream.process.kill('SIGTERM');
            }
            
            const streamDir = path.join(hlsDir, streamId);
            if (fs.existsSync(streamDir)) {
                fs.rmSync(streamDir, { recursive: true, force: true });
            }
        } catch (error) {
            console.error(`❌ Error cleaning up stream ${streamId}:`, error);
        }
    }
    
    activeStreams.clear();
    streamMetrics.clear();
    console.log('✅ Cleanup completed');
    process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    cleanup();
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, async () => {
    console.log(`=================================`);
    console.log(`🚀 Enhanced FLV to HLS Server`);
    console.log(`=================================`);
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📁 HLS files served at: http://localhost:${PORT}/hls/`);
    console.log(`📊 Active streams: http://localhost:${PORT}/api/streams/active`);
    console.log(`⚙️  Max concurrent streams: ${config.maxConcurrentStreams}`);
    console.log(`⏱️  Stream timeout: ${config.streamTimeout / 1000}s`);
    console.log(`🔧 Segment duration: ${config.segmentDuration}s`);
    console.log(`🧹 Cleanup interval: ${config.cleanupInterval / 1000}s`);
    console.log(`=================================`);
    
    const ffmpegAvailable = await checkFFmpegHealth();
    if (ffmpegAvailable) {
        console.log('✅ FFmpeg is available and working');
    } else {
        console.error('❌ WARNING: FFmpeg is not installed or not working');
        console.error('   Please install FFmpeg to use this server');
        console.error('   Visit: https://ffmpeg.org/download.html');
    }

    console.log('=================================');
    console.log('🎯 Enhanced server ready to handle multiple concurrent streams!');
    console.log(`💡 Server can handle up to ${config.maxConcurrentStreams} simultaneous video streams`);
});