const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();
const cors = require("cors");

// 🔥 NEW: AWS + Multer
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const multer = require("multer");

const app = express();

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    console.log("REQUEST RECEIVED:", req.method, req.url);
    next();
});


// 🔥 File upload setup
const upload = multer({ storage: multer.memoryStorage() });

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET_KEY
    }
});


// 🔹 STEP 1: Fetch Access Token
async function fetchSalesforceAccessToken() {
    const response = await axios.post(
        "https://pulseforce.my.salesforce.com/services/oauth2/token",
        new URLSearchParams({
            grant_type: "client_credentials",
            client_id: process.env.SF_CLIENT_ID,
            client_secret: process.env.SF_CLIENT_SECRET
        }),
        {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            }
        }




        
    );

    return response.data.access_token;
}


// 🔹 STEP 2: Create Session
async function createAgentSession(accessToken) {
    const response = await axios.post(
        "https://api.salesforce.com/einstein/ai-agent/v1/agents/0XxKY000001Dx8b0AC/sessions",
        {
            externalSessionKey: crypto.randomUUID(),
            instanceConfig: {
                endpoint: "https://pulseforce.my.salesforce.com"
            },
            tz: "America/Los_Angeles",
            variables: [
                {
                    name: "$Context.EndUserLanguage",
                    type: "Text",
                    value: "en_US"
                }
            ],
            featureSupport: "Streaming",
            streamingCapabilities: {
                chunkTypes: ["Text"]
            },
            bypassUser: true
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            }
        }
    );

    return response.data.sessionId;
}


// 🔹 STEP 3: Send Message
async function sendMessage(accessToken, sessionId, userMessage) {
    const response = await axios.post(
        `https://api.salesforce.com/einstein/ai-agent/v1/sessions/${sessionId}/messages`,
        {
            message: {
                sequenceId: Date.now(),
                type: "Text",
                text: userMessage
            },
            variables: []
        },
        {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                Accept: "application/json"
            }
        }
    );

    return response.data.messages?.[0]?.message;
}


// 🔹 AWS Upload Function
async function uploadToS3(file) {
    const fileName = `${Date.now()}-${file.originalname}`;

    const command = new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype
    });

    await s3.send(command);

    return `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
}


// 🔹 EXISTING CHAT API (UNCHANGED)
app.post("/chat", async (req, res) => {
    try {
         console.log("CHAT API HIT");
        console.log(req.body);
        const userMessage = req.body.message;

        if (!userMessage) {
            return res.status(400).json({ error: "Message is required" });
        }

        const accessToken = await fetchSalesforceAccessToken();
        const sessionId = await createAgentSession(accessToken);
        const reply = await sendMessage(accessToken, sessionId, userMessage);

        res.json({ sessionId, reply });

    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ error: "Something went wrong" });
    }
});


// 🔹 NEW: IMAGE UPLOAD + ANALYSIS
app.post("/upload-and-analyze", upload.single("image"), async (req, res) => {
    try {
        console.log("UPLOAD API HIT");
        if (!req.file) {
            return res.status(400).json({ error: "Image is required" });
        }

        // Upload to S3
        const imageUrl = await uploadToS3(req.file);

        const accessToken = await fetchSalesforceAccessToken();
        const sessionId = await createAgentSession(accessToken);

        const finalMessage = `Analyze this image: ${imageUrl}`;

        const reply = await sendMessage(accessToken, sessionId, finalMessage);

        res.json({
            imageUrl,
            reply
        });

    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ error: "Image processing failed" });
    }
});


// 🔹 START SERVER
app.listen(5000, "0.0.0.0", () => {
    console.log("Server running at http://localhost:5000");
});