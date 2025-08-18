var WrtcHelper = (function () {
  // Constants
  const ICE_CONFIGURATION = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      // Consider adding TURN servers for better NAT traversal
      // { urls: "turn:your-turn-server.com", username: "user", credential: "pass" }
    ]
  };

  const VideoStates = Object.freeze({
    NONE: 0,
    CAMERA: 1,
    SCREEN_SHARE: 2
  });

  // Private variables
  let audioTrack = null;
  let peersConns = {};
  let peersConIds = [];
  let remoteVideoStreams = {};
  let remoteAudioStreams = {};
  let localVideoPlayer = null;
  let rtpVideoSenders = {};
  let rtpAudioSenders = {};
  let serverFn = null;
  let videoState = VideoStates.NONE;
  let videoCamSSTrack = null;
  let isAudioMute = true;
  let myConnId = "";

  // Private methods
  async function init(serFn, myconnid) {
    myConnId = myconnid;
    serverFn = serFn;
    localVideoPlayer = document.getElementById("localVideoCtr");
    
    if (!localVideoPlayer) {
      console.error("Local video container not found");
      return;
    }

    eventBinding();
  }

  function eventBinding() {
    const $btnMuteUnmute = $("#btnMuteUnmute");
    const $btnStartStopCam = $("#btnStartStopCam");
    const $btnStartStopScreenshare = $("#btnStartStopScreenshare");

    if (!$btnMuteUnmute.length || !$btnStartStopCam.length || !$btnStartStopScreenshare.length) {
      console.error("Required buttons not found in DOM");
      return;
    }

    $btnMuteUnmute.on("click", handleMuteUnmute);
    $btnStartStopCam.on("click", () => handleVideoStateChange(VideoStates.CAMERA));
    $btnStartStopScreenshare.on("click", () => handleVideoStateChange(VideoStates.SCREEN_SHARE));
  }

  async function handleMuteUnmute() {
    try {
      if (!audioTrack) {
        await startWithAudio();
        if (!audioTrack) {
          showAlert("Problem with audio permission");
          return;
        }
      }

      isAudioMute = !isAudioMute;
      audioTrack.enabled = !isAudioMute;

      const $this = $(this);
      $this.html(isAudioMute 
        ? '<span class="material-icons">mic_off</span>' 
        : '<span class="material-icons">mic</span>');

      if (isAudioMute) {
        await removeAudioVideoSenders(rtpAudioSenders);
      } else {
        await addUpdateAudioVideoSenders(audioTrack, rtpAudioSenders);
      }
    } catch (error) {
      console.error("Mute/unmute error:", error);
      showAlert("Error toggling audio");
    }
  }

  async function handleVideoStateChange(newVideoState) {
    try {
      // If clicking the current active state, turn it off
      if (videoState === newVideoState) {
        newVideoState = VideoStates.NONE;
      }

      await manageVideo(newVideoState);
    } catch (error) {
      console.error("Video state change error:", error);
      showAlert("Error changing video state");
    }
  }

  async function manageVideo(newVideoState) {
    try {
      // Clean up previous state
      if (videoState !== VideoStates.NONE) {
        await clearCurrentVideoCamStream(rtpVideoSenders);
      }

      // Update UI based on new state
      updateVideoUI(newVideoState);

      videoState = newVideoState;

      // Handle new media if needed
      if (newVideoState !== VideoStates.NONE) {
        await setupNewVideoStream(newVideoState);
      }
    } catch (error) {
      console.error("Video management error:", error);
      throw error;
    }
  }

  function updateVideoUI(newVideoState) {
    const $btnStartStopCam = $("#btnStartStopCam");
    const $btnStartStopScreenshare = $("#btnStartStopScreenshare");

    switch (newVideoState) {
      case VideoStates.NONE:
        $btnStartStopCam.html('<span class="material-icons">videocam_off</span>');
        $btnStartStopScreenshare.html(
          '<div class="present-now-wrap d-flex justify-content-center flex-column align-items-center mr-5 cursor-pointer" id="btnStartStopScreenshare" style="height:10vh;">' +
            '<div class="present-now-icon"><span class="material-icons">present_to_all</span></div>' +
            '<div>Present Now</div>' +
          '</div>'
        );
        break;
      case VideoStates.CAMERA:
        $btnStartStopCam.html('<span class="material-icons">videocam</span>');
        $btnStartStopScreenshare.text("Screen Share");
        break;
      case VideoStates.SCREEN_SHARE:
        $btnStartStopCam.html('<span class="material-icons">videocam_off</span>');
        $btnStartStopScreenshare.html(
          '<div class="present-now-wrap d-flex justify-content-center flex-column align-items-center mr-5 cursor-pointer" id="btnStartStopScreenshare" style="height:10vh;">' +
            '<div class="present-now-icon"><span class="material-icons">present_to_all</span></div>' +
            '<div>Stop Present Now</div>' +
          '</div>'
        );
        break;
    }
  }

  async function setupNewVideoStream(newVideoState) {
    let stream;
    try {
      if (newVideoState === VideoStates.CAMERA) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1920, height: 1080 },
          audio: false
        });
      } else if (newVideoState === VideoStates.SCREEN_SHARE) {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1920, height: 1080 },
          audio: false
        });

        stream.getVideoTracks()[0].onended = () => {
          manageVideo(VideoStates.NONE);
        };
      }

      if (stream && stream.getVideoTracks().length > 0) {
        videoCamSSTrack = stream.getVideoTracks()[0];
        localVideoPlayer.srcObject = new MediaStream([videoCamSSTrack]);
        await addUpdateAudioVideoSenders(videoCamSSTrack, rtpVideoSenders);
      }
    } catch (error) {
      console.error("Stream setup error:", error);
      throw error;
    }
  }

  async function clearCurrentVideoCamStream(rtpSenders) {
    if (videoCamSSTrack) {
      videoCamSSTrack.stop();
      videoCamSSTrack = null;
      localVideoPlayer.srcObject = null;
      await removeAudioVideoSenders(rtpSenders);
    }
  }

  async function removeAudioVideoSenders(rtpSenders) {
    await Promise.all(Object.keys(rtpSenders).map(async (conId) => {
      if (rtpSenders[conId] && isConnectionAvailable(peersConns[conId])) {
        peersConns[conId].removeTrack(rtpSenders[conId]);
        rtpSenders[conId] = null;
      }
    }));
  }

  async function addUpdateAudioVideoSenders(track, rtpSenders) {
    await Promise.all(Object.keys(rtpSenders).map(async (conId) => {
      if (isConnectionAvailable(peersConns[conId])) {
        if (rtpSenders[conId] && rtpSenders[conId].track) {
          await rtpSenders[conId].replaceTrack(track);
        } else {
          rtpSenders[conId] = peersConns[conId].addTrack(track);
        }
      }
    }));
  }

  async function startWithAudio() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: true
      });
      
      audioTrack = stream.getAudioTracks()[0];
      audioTrack.enabled = false;
      
      audioTrack.onmute = (e) => console.log("Audio muted", e);
      audioTrack.onunmute = (e) => console.log("Audio unmuted", e);
    } catch (error) {
      console.error("Audio start error:", error);
      throw error;
    }
  }

  async function createConnection(connId) {
    try {
      const connection = new RTCPeerConnection(ICE_CONFIGURATION);
      
      // Event handlers
      connection.onicecandidate = (event) => {
        if (event.candidate) {
          serverFn(JSON.stringify({ iceCandidate: event.candidate }), connId);
        }
      };
      
      connection.oniceconnectionstatechange = () => {
        console.log("ICE connection state:", connection.iceConnectionState);
      };
      
      connection.onsignalingstatechange = () => {
        console.log("Signaling state:", connection.signalingState);
      };
      
      connection.onconnectionstatechange = () => {
        console.log("Connection state:", connection.connectionState);
      };
      
      connection.ontrack = (event) => {
        handleRemoteTrack(event, connId);
      };
      
      // Store connection
      peersConIds.push(connId);
      peersConns[connId] = connection;
      
      // Add existing tracks if available
      if ((videoState === VideoStates.CAMERA || videoState === VideoStates.SCREEN_SHARE) && videoCamSSTrack) {
        await addUpdateAudioVideoSenders(videoCamSSTrack, rtpVideoSenders);
      }
      
      return connection;
    } catch (error) {
      console.error("Connection creation error:", error);
      throw error;
    }
  }

  function handleRemoteTrack(event, connId) {
    if (!event.track) return;

    const track = event.track;
    const kind = track.kind;
    
    if (kind === "video") {
      if (!remoteVideoStreams[connId]) {
        remoteVideoStreams[connId] = new MediaStream();
      }
      
      // Clear existing tracks of same kind
      remoteVideoStreams[connId].getTracks().forEach(t => remoteVideoStreams[connId].removeTrack(t));
      remoteVideoStreams[connId].addTrack(track);
      
      const remoteVideoPlayer = document.getElementById(`v_${connId}`);
      if (remoteVideoPlayer) {
        remoteVideoPlayer.srcObject = remoteVideoStreams[connId];
      }
    } 
    else if (kind === "audio") {
      if (!remoteAudioStreams[connId]) {
        remoteAudioStreams[connId] = new MediaStream();
      }
      
      remoteAudioStreams[connId].getTracks().forEach(t => remoteAudioStreams[connId].removeTrack(t));
      remoteAudioStreams[connId].addTrack(track);
      
      const remoteAudioPlayer = document.getElementById(`a_${connId}`);
      if (remoteAudioPlayer) {
        remoteAudioPlayer.srcObject = remoteAudioStreams[connId];
      }
    }
  }

  async function createOffer(connId) {
    try {
      const connection = peersConns[connId];
      if (!connection) throw new Error("Connection not found");
      
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      
      serverFn(JSON.stringify({ offer: connection.localDescription }), connId);
    } catch (error) {
      console.error("Offer creation error:", error);
      throw error;
    }
  }

  async function exchangeSDP(message, fromConnId) {
    try {
      const data = JSON.parse(message);
      
      if (!peersConns[fromConnId]) {
        await createConnection(fromConnId);
      }
      
      if (data.answer) {
        await peersConns[fromConnId].setRemoteDescription(new RTCSessionDescription(data.answer));
      } 
      else if (data.offer) {
        await peersConns[fromConnId].setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await peersConns[fromConnId].createAnswer();
        await peersConns[fromConnId].setLocalDescription(answer);
        
        serverFn(JSON.stringify({ answer }), fromConnId, myConnId);
      } 
      else if (data.iceCandidate) {
        try {
          await peersConns[fromConnId].addIceCandidate(data.iceCandidate);
        } catch (e) {
          console.error("Error adding ICE candidate:", e);
        }
      }
    } catch (error) {
      console.error("SDP exchange error:", error);
      throw error;
    }
  }

  function isConnectionAvailable(connection) {
    return connection && 
           ["new", "connecting", "connected"].includes(connection.connectionState);
  }

  function closeConnection(connId) {
    try {
      // Remove from peer lists
      peersConIds = peersConIds.filter(id => id !== connId);
      
      // Close RTCPeerConnection
      if (peersConns[connId]) {
        peersConns[connId].close();
        delete peersConns[connId];
      }
      
      // Clean up media streams
      cleanupMediaStream(remoteAudioStreams, connId);
      cleanupMediaStream(remoteVideoStreams, connId);
      
      // Clean up senders
      delete rtpAudioSenders[connId];
      delete rtpVideoSenders[connId];
    } catch (error) {
      console.error("Connection close error:", error);
    }
  }

  function cleanupMediaStream(streams, connId) {
    if (streams[connId]) {
      streams[connId].getTracks().forEach(track => track.stop());
      delete streams[connId];
    }
  }

  function showAlert(message) {
    // Consider using a more user-friendly notification system
    console.warn("Alert:", message);
    alert(message);
  }

  // Public API
  return {
    init: async function(serverFn, myConnId) {
      await init(serverFn, myConnId);
    },
    executeClientFn: async function(data, fromConnId) {
      await exchangeSDP(data, fromConnId);
    },
    createNewConnection: async function(connId) {
      await createConnection(connId);
    },
    closeExistingConnection: function(connId) {
      closeConnection(connId);
    }
  };
})();

var MyApp = (function() {
  // Constants
  const DEFAULT_SOCKET_URL = "http://localhost:3000";
  
  // Private variables
  let socket = null;
  let meetingId = "";
  let userId = "";

  // Private methods
  function init(uid, mid) {
    userId = uid;
    meetingId = mid;

    // Update UI
    $("#me h2").text(`${userId}(Me)`);
    document.title = userId;

    // Initialize event handlers
    signalServerEventBinding();
    bindEvents();
  }

  function signalServerEventBinding() {
    socket = io.connect(DEFAULT_SOCKET_URL, {
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    const serverFn = (data, toConnId) => {
      socket.emit("exchangeSDP", {
        message: data,
        to_connid: toConnId
      });
    };

    // Socket event handlers
    socket.on("connect", handleSocketConnect(serverFn));
    socket.on("disconnect", handleSocketDisconnect);
    socket.on("reset", handleReset);
    socket.on("exchangeSDP", handleExchangeSDP);
    socket.on("informAboutNewConnection", handleNewConnection);
    socket.on("informAboutConnectionEnd", handleConnectionEnd);
    socket.on("showChatMessage", showChatMessage);
    socket.on("showFileMessage", showFileMessage);
    socket.on("userconnected", handleUserConnected);
    socket.on("connect_error", handleConnectError);
  }

  function handleSocketConnect(serverFn) {
    return () => {
      if (socket.connected) {
        WrtcHelper.init(serverFn, socket.id);

        if (userId && meetingId) {
          socket.emit("userconnect", {
            displayName: userId,
            meetingid: meetingId
          });
        }
      }
    };
  }

  function handleSocketDisconnect() {
    console.log("Disconnected from signaling server");
    // Consider showing reconnect UI
  }

  function handleReset() {
    location.reload();
  }

  async function handleExchangeSDP(data) {
    try {
      await WrtcHelper.executeClientFn(data.message, data.from_connid);
    } catch (error) {
      console.error("Error handling SDP exchange:", error);
    }
  }

  function handleNewConnection(data) {
    addNewUser(data.other_user_id, data.connId, data.userNumber);
    WrtcHelper.createNewConnection(data.connId);
  }

  function handleConnectionEnd(data) {
    $(`#${data.connId}`).remove();
    $(`#participant_${data.connId}`).remove();
    $(".participant-count").text(data.userCoun);
    WrtcHelper.closeExistingConnection(data.connId);
  }

  function showChatMessage(data) {
    const time = new Date().toLocaleString("en-US", {
      hour: "numeric",
      minute: "numeric",
      hour12: true
    });

    const messageHtml = `
      <div class="message">
        <span class="font-weight-bold mr-3" style="color:black">${data.from}</span>
        ${time}<br/>
        ${data.message}
      </div>
    `;
    
    $("#messages").append(messageHtml);
    scrollToBottom();
  }

  function showFileMessage(data) {
    const attachFileArea = document.querySelector(".show-attach-file");
    if (!attachFileArea) return;

    const fileHtml = `
      <div class="left-align" style="display:flex;align-items:center;">
        <img src="assets/images/other.jpg" style="height:40px;width:40px;" class="caller-image circle">
        <div style="font-weight:600;margin:0 5px;">${data.username}</div>: 
        <div>
          <a style="color:#007bff;" href="${data.FileePath}" download>
            ${data.fileeName}
          </a>
        </div>
      </div>
      <br/>
    `;
    
    attachFileArea.insertAdjacentHTML("beforeend", fileHtml);
    scrollToBottom();
  }

  function handleUserConnected(otherUsers) {
    $("#divUsers .other").remove();
    
    const userCount = otherUsers.length + 1;
    
    otherUsers.forEach(user => {
      addNewUser(user.user_id, user.connectionId, userCount);
      WrtcHelper.createNewConnection(user.connectionId);
    });

    $(".toolbox").show();
    $("#messages").show();
    $("#divUsers").show();
  }

  function handleConnectError(error) {
    console.error("Connection error:", error);
    // Consider showing error to user and retry logic
  }

  function bindEvents() {
    $("#btnResetMeeting").on("click", () => socket.emit("reset"));
    
    $("#btnsend").on("click", sendChatMessage);
    
    $("#divUsers").on("dblclick", "video", function() {
      this.requestFullscreen().catch(e => console.error("Fullscreen error:", e));
    });
    
    $(".share-button-wrap").on("click", handleFileShare);
  }

  function sendChatMessage() {
    const message = $("#msgbox").val().trim();
    if (!message) return;

    socket.emit("sendMessage", message);
    $("#msgbox").val("");
  }

  function handleFileShare() {
    const fileInput = $("#customFile")[0];
    if (!fileInput || !fileInput.files.length) return;

    const fileName = fileInput.files[0].name;
    const filePath = `/attachment/${meetingId}/${fileName}`;

    const attachFileArea = document.querySelector(".show-attach-file");
    if (!attachFileArea) return;

    // Add to local UI immediately
    attachFileArea.insertAdjacentHTML("beforeend", `
      <div class="left-align" style="display:flex;align-items:center;">
        <img src="assets/images/other.jpg" style="height:40px;width:40px;" class="caller-image circle">
        <div style="font-weight:600;margin:0 5px;">${userId}</div>: 
        <div>
          <a style="color:#007bff;" href="${filePath}" download>
            ${fileName}
          </a>
        </div>
      </div>
      <br/>
    `);

    // Send to other participants
    socket.emit("fileTransferToOther", {
      username: userId,
      meetingid: meetingId,
      FileePath: filePath,
      fileeName: fileName
    });

    // Clear file input
    $("label.custom-file-label").text("");
  }

  function addNewUser(otherUserId, connId, userCount) {
    // Add to video grid
    const $newDiv = $("#otherTemplate").clone()
      .attr("id", connId)
      .addClass("other")
      .show();
    
    $newDiv.find("h2").text(otherUserId);
    $newDiv.find("video").attr("id", `v_${connId}`);
    $newDiv.find("audio").attr("id", `a_${connId}`);
    
    $("#divUsers").append($newDiv);

    // Add to participant list
    $(".in-call-wrap-up").append(`
      <div class="in-call-wrap d-flex justify-content-between align-items-center mb-3" id="participant_${connId}">
        <div class="participant-img-name-wrap display-center cursor-pointer">
          <div class="participant-img">
            <img src="images/me2.png" alt="" class="border border-secondary" style="height:40px;width:40px;border-radius:50%;">
          </div>
          <div class="participant-name ml-2">${otherUserId}</div>
        </div>
        <div class="participant-action-wrap display-center">
          <div class="participant-action-dot display-center mr-2 cursor-pointer">
            <span class="material-icons">more_vert</span>
          </div>
          <div class="participant-action-pin display-center cursor-pointer">
            <span class="material-icons">push_pin</span>
          </div>
        </div>
      </div>
    `);

    $(".participant-count").text(userCount);
  }

  function scrollToBottom() {
    const messagesContainer = $("#messages")[0];
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  // Public API
  return {
    _init: function(uid, mid) {
      init(uid, mid);
    }
  };
})();
