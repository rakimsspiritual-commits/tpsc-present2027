require("./models/db");
require('dotenv').config();

const express = require("express");
const path = require("path");
const { engine } = require("express-handlebars");
const bodyParser = require("body-parser");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const mongoose = require("mongoose");
const cors = require("cors");

// Controllers
const employeeController = require("./controllers/employeeController");
const homeController = require("./controllers/homeController");
const loginController = require("./controllers/loginController");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware Configuration
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.PRODUCTION_URL 
    : `http://localhost:${PORT}`,
  credentials: true
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(fileUpload());
app.use(express.static(path.join(__dirname, "public")));

// View Engine Setup
app.set("views", path.join(__dirname, "/views/"));
app.engine("hbs", engine({
  extname: "hbs",
  defaultLayout: "mainLayout",
  layoutsDir: __dirname + "/views/layouts/",
}));
app.set("view engine", "hbs");

// Routes
app.use("/employee", employeeController);
app.use("/", homeController);
app.use("/sign", loginController);

// Socket.IO Server Setup
const server = require('http').createServer(app);
const io = require("socket.io")(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? process.env.PRODUCTION_URL 
      : `http://localhost:${PORT}`,
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000
});

// WebRTC Connection Management
const userConnections = [];

io.on("connection", (socket) => {
  console.log(`New connection: ${socket.id}`);

  // User Connection Handler
  socket.on("userconnect", (data) => {
    console.log(`User connected: ${data.displayName} to meeting ${data.meetingid}`);

    const otherUsers = userConnections.filter(
      user => user.meeting_id === data.meetingid
    );

    userConnections.push({
      connectionId: socket.id,
      user_id: data.displayName,
      meeting_id: data.meetingid,
    });

    const userCount = userConnections.length;
    console.log(`Total users: ${userCount}`);

    // Notify other users about new connection
    otherUsers.forEach(user => {
      socket.to(user.connectionId).emit("informAboutNewConnection", {
        other_user_id: data.displayName,
        connId: socket.id,
        userNumber: userCount,
      });
    });

    // Send existing users to new connection
    socket.emit("userconnected", otherUsers);
  });

  // WebRTC Signaling
  socket.on("exchangeSDP", (data) => {
    socket.to(data.to_connid).emit("exchangeSDP", {
      message: data.message,
      from_connid: socket.id,
    });
  });

  // Meeting Reset
  socket.on("reset", (data) => {
    const userObj = userConnections.find(user => user.connectionId === socket.id);
    if (userObj) {
      const meetingid = userObj.meeting_id;
      const meetingUsers = userConnections.filter(user => user.meeting_id === meetingid);
      
      // Remove all users from this meeting
      userConnections = userConnections.filter(
        user => user.meeting_id !== meetingid
      );

      // Notify all users in meeting
      meetingUsers.forEach(user => {
        socket.to(user.connectionId).emit("reset");
      });

      socket.emit("reset");
    }
  });

  // Chat Messaging
  socket.on("sendMessage", (msg) => {
    const userObj = userConnections.find(user => user.connectionId === socket.id);
    if (userObj) {
      const meetingid = userObj.meeting_id;
      const from = userObj.user_id;

      const meetingUsers = userConnections.filter(user => user.meeting_id === meetingid);

      // Broadcast message to all meeting participants
      meetingUsers.forEach(user => {
        socket.to(user.connectionId).emit("showChatMessage", {
          from: from,
          message: msg,
          time: getCurrentDateTime(),
        });
      });

      // Also send to sender
      socket.emit("showChatMessage", {
        from: from,
        message: msg,
        time: getCurrentDateTime(),
      });
    }
  });

  // File Transfer
  socket.on("fileTransferToOther", (msg) => {
    const userObj = userConnections.find(user => user.connectionId === socket.id);
    if (userObj) {
      const meetingid = userObj.meeting_id;
      const from = userObj.user_id;

      const meetingUsers = userConnections.filter(user => user.meeting_id === meetingid);

      meetingUsers.forEach(user => {
        socket.to(user.connectionId).emit("showFileMessage", {
          from: from,
          username: msg.username,
          meetingid: msg.meetingid,
          filePath: msg.filePath,
          fileName: msg.fileName,
          time: getCurrentDateTime(),
        });
      });
    }
  });

  // Disconnection Handler
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    const userObj = userConnections.find(user => user.connectionId === socket.id);
    if (userObj) {
      const meetingid = userObj.meeting_id;

      // Remove disconnected user
      userConnections = userConnections.filter(
        user => user.connectionId !== socket.id
      );

      const remainingUsers = userConnections.filter(user => user.meeting_id === meetingid);

      // Notify remaining users
      remainingUsers.forEach(user => {
        const userCount = userConnections.length;
        socket.to(user.connectionId).emit("informAboutConnectionEnd", {
          connId: socket.id,
          userCount: userCount,
        });
      });
    }
  });
});

// File Upload Endpoints
const Game = mongoose.model("Game", new mongoose.Schema({
  title: String,
  creator: String,
  width: Number,
  height: Number,
  fileName: String,
  thumbnailFile: String,
  meetingid: String,
  username: String,
}));

app.post("/attachimg_other_info", (req, res) => {
  res.send(req.body.meeting_id);
});

app.post("/attachimg", async (req, res) => {
  try {
    const { meeting_id, username, title, creator, width, height } = req.body;
    const imageFile = req.files.zipfile;
    
    // Create meeting directory if it doesn't exist
    const dir = `public/attachment/${meeting_id}/`;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Move uploaded file
    await imageFile.mv(`${dir}${imageFile.name}`);

    // Save to database
    await Game.create({
      title,
      creator,
      width,
      height,
      thumbnailFile: imageFile.name,
      meetingid: meeting_id,
      username,
    });

    res.send(creator);
  } catch (error) {
    console.error("File upload error:", error);
    res.status(500).send("Error uploading file");
  }
});

// Helper Functions
function getCurrentDateTime() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start Server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
