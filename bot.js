// == Require Our Stuff == //
var fs = require('fs');
var Steam = require('steam');
var SteamUser = require('steam-user');
var TradeOfferManager = require('steam-tradeoffer-manager');
var Winston = require('winston');
var randomstring = require('randomstring');
var express = require('express');
var bodyParser = require('body-parser');
var Firebase = require('firebase');
var FirebaseTokenGenerator = require("firebase-token-generator");
var tokenGenerator = new FirebaseTokenGenerator(process.env.FIREBASE_SECRET);
var token = tokenGenerator.createToken({uid: "snipego"}, {admin: true});

var ref = new Firebase('https://snipego.firebaseio.com/');

ref.authWithCustomToken(token, function(error, authData) {
  if (error) {
    console.log('error! ', error);
  } else {
    console.log('Authenticated');
  }
});

var pendingRef = new Firebase('https://snipego.firebaseio.com/pending_offers');

var queueRef = new Firebase('https://snipego.firebaseio.com/queue');

var userRef = new Firebase('https://snipego.firebaseio.com/users');

// == setup winston logger interfaces == //
var logger = new (Winston.Logger)({
  transports: [
    new (Winston.transports.Console)({
      colorize: true,
      level: 'debug'
    }),
    new (Winston.transports.File)({
      level: 'info',
      timestamp: true,
      filename: 'cratedump.log',
      json: false
    })
  ]
});

// Initialize the Steam client and our trading library
var client = new SteamUser();
var offers = new TradeOfferManager({
    steam:        client,
    domain:       'snipego.com',
    language:     "en", // English item descriptions
    pollInterval: 10000, // (Poll every 10 seconds (10,000 ms)
    cancelTime:   3600000 // Expire any outgoing trade offers that have been up for 5+ minutes (300,000 ms)
});

// == BOT INFO == //
var botInfo = {
  username: process.env.STEAM_USER,
  password: process.env.STEAM_PASS,
  id: 1,
  name: process.env.STEAM_NAME,
  port: process.env.PORT,
  sentry: function() {
    if(fs.existsSync(__dirname + '/sentry/ssfn/' + botInfo.username + '.ssfn')) {
      var sha = require('crypto').createHash('sha1');
      sha.update(fs.readFileSync(__dirname + '/sentry/ssfn/' + botInfo.username + '.ssfn'));
      return new Buffer(sha.digest(), 'binary');
    }
    else if (fs.existsSync(__dirname + '/sentry/' + botInfo.username + '_sentryfile.hash')) {
      return fs.readFileSync(__dirname + '/sentry/' + botInfo.username + '_sentryfile.hash');
    } else {
      return null;
    }
  }
};

fs.readFile('polldata.json', function (err, data) {
  if (err) {
    logger.warn('Error reading polldata.json. If this is the first run, this is expected behavior: '+err);
  } else {
    logger.debug("Found previous trade offer poll data.  Importing it to keep things running smoothly.");
    offers.pollData = JSON.parse(data);
  }
});

client.setSentry(botInfo.sentry());

client.logOn({
  accountName: botInfo.username,
  password: botInfo.password,
});

client.on('loggedOn', function (details) {
  logger.info("Logged into Steam as " + client.steamID.getSteam3RenderedID());
});

client.on('error', function (e) {
  // Some error occurred during logon.  ENums found here:
  // https://github.com/SteamRE/SteamKit/blob/SteamKit_1.6.3/Resources/SteamLanguage/eresult.steamd
  logger.error(e);
  process.exit(1);
});

client.on('webSession', function (sessionID, cookies) {
  logger.debug("Got web session");
  client.friends.setPersonaState(SteamUser.Steam.EPersonaState.Online);
  offers.setCookies(cookies, function (err){
    if (err) {
      logger.error('Unable to set trade offer cookies: ' + err);
      process.exit(1);
    }
    init_app();
    logger.debug("Trade offer cookies set.  Got API Key: " + offers.apiKey);
  });
});

client.on('accountLimitations', function (limited, communityBanned, locked, canInviteFriends) {
  if (limited) {
    logger.warn("Our account is limited. We cannot send friend invites, use the market, open group chat, or access the web API.");
  }
  if (communityBanned){
    logger.warn("Our account is banned from Steam Community");
  }
  if (locked){
    logger.error("Our account is locked. We cannot trade/gift/purchase items, play on VAC servers, or access Steam Community.  Shutting down.");
    process.exit(1);
  }
  if (!canInviteFriends){
    logger.warn("Our account is unable to send friend requests.");
  }
});

offers.on('newOffer', function (offer) {
  logger.info("New offer #" + offer.id + " from " + offer.partner.getSteam3RenderedID());
  logger.info("User " + offer.partner.getSteam3RenderedID() + " offered an invalid trade.  Declining offer.");
  offer.decline(function (err) {
    if (err) {
      logger.error("Unable to decline offer " + offer.id + " : " + err.message);
    } else {
      logger.debug("Offer declined");
    }
  });
});

offers.on('sentOfferChanged', function (offer, oldState) {
  if (offer.state == TradeOfferManager.ETradeOfferState.Accepted) {
    logger.info("Our sent offer # " + offer.id + " has been accepted.");
    pendingRef.child(offer.id).once('value', function(trade) {
      var tradeData = trade.val();
      if (tradeData) {
        queueRef.once('value', function(queue) {
          var queueData = queue.val();
          if (queueData) {
            queueData.push(tradeData);
            queueRef.update(queueData);
          } else {
            queueData = [tradeData];
            queueRef.set(queueData, function() {
              console.log('Successfully added pending offer to queue');
            });
          }
          delete tradeData[offer.id];
          pendingRef.set(tradeData, function() {
            console.log('Cleared item from pending queue');
          });
        });
      }
    });
  } else {
    console.log('Hey there was an issue', TradeOfferManager.ETradeOfferState.Declined);
  }
});

// Steam is down or the API is having issues
offers.on('pollFailure', function (err) {
  logger.error("Error polling for trade offers: " + err);
});

// When we receive new trade offer data, save it so we can use it after a crash/quit
offers.on('pollData', function (pollData) {
  fs.writeFile('polldata.json', JSON.stringify(pollData));
});


// == define offer server == //
var offer_server = express();
offer_server.use(bodyParser.json()); // == to support JSON-encoded bodies == //
offer_server.use(bodyParser.urlencoded({ extended: true})); // == To support URL-encoded bodies == //


// == our main start funciton to run when steam is all set up == //
function init_app() {
  logger.log('info', 'Bot is now fully logged in');

  // == init app can be called when we relogin and in that case we dont wanna start over our logger or offer server == //
  if (botInfo.state !== 'running') {
  //   backpack_logger.start();

    var offer_server_handle = start_offer_server();

    botInfo.state = 'running';

    // == in the event of fatal error== //

    //do something when app is closing
    process.on('exit', exitHandler.bind(null,{server_handle : offer_server_handle, cleanup: true, exit:true}));
    //catches ctrl+c event
    process.on('SIGINT', exitHandler.bind(null, {server_handle : offer_server_handle, cleanup: true, exit:true}));
    //catches uncaught exceptions
    process.on('uncaughtException', exitHandler.bind(null, {server_handle : offer_server_handle, exit:true}));
  }

}


// =============== the offer server and its command routes ================ //

var start_offer_server = function() {
  var offer_server_handle = offer_server.listen(botInfo.port);
  return offer_server_handle;
};

var userDeposit = function(userInfo, res) {

  var trade = offers.createOffer(userInfo.id);
  var protectionCode = randomstring.generate(7).toUpperCase();

  trade.addTheirItems(userInfo.items);
  trade.send('Deposit for SnipeGo jackpot, seems like a lucky one! Protection Code: ' + protectionCode, userInfo.tradeToken, function(err, status) {
    if (err) {
      logger.log('info', err);
      offerError(err, userInfo, res, false);
    } else {
      pendingRef.child(trade.id).set({avatar: userInfo.avatar, displayName: userInfo.displayName, id: userInfo.id, items: userInfo.items, itemsCount: userInfo.itemsCount, itemsValue: userInfo.itemsValue, tradeToken: userInfo.tradeToken});
      userRef.child(userInfo.id).update({
        tradeID: trade.id,
        protectionCode: protectionCode,
      });
      res.json({status: 'Trade offer status: ' + status + ', protection code: ' + protectionCode + ' trade ID: ' + trade.id});
    }
  });
};

offer_server.post('/user-deposit', function(req, res) {
  console.log('CALLING BOT DEPOSIT', req.body);
  var userInfo = req.body;
  userDeposit(userInfo, res);
});

var userWithdraw = function(userInfo, res) {

  var items = [];
  var rake = false;
  var rakeTen = userInfo.jackpotValue * 0.10;
  var rakeNine = userInfo.jackpotValue * 0.09;
  var rakeEight = userInfo.jackpotValue * 0.08;
  var rakeSeven = userInfo.jackpotValue * 0.07;
  var rakeSix = userInfo.jackpotValue * 0.06;
  var rakeFive = userInfo.jackpotValue * 0.05;
  var rakeFour = userInfo.jackpotValue * 0.04;
  var rakeThree = userInfo.jackpotValue * 0.03;
  var rakeTwo = userInfo.jackpotValue * 0.02;

  offers.loadInventory(730, 2, true, function (err, inventory) {
    var inventoryData = inventory;
    console.log('Loading inventory');
    if (err) {
      logger.log('info', err);
    } else {
      for (var i = 0; i < userInfo.items.length; i++) {
        for (var j = 0; j < inventoryData.length; j++) {
          if (inventoryData[j].market_hash_name.replace(/[.#$]/g, "") === userInfo.items[i].market_hash_name) {
            var itemPrice = parseFloat(userInfo.items[i].market_price);
            if (!rake) {
              if (itemPrice > rakeNine && itemPrice < rakeTen) {
                rake = true;
                break;
              }
              else if (itemPrice > rakeEight && itemPrice < rakeNine) {
                rake = true;
                break;
              }
              else if (itemPrice > rakeSeven && itemPrice < rakeEight) {
                rake = true;
                break;
              }
              else if (itemPrice > rakeSix && itemPrice < rakeSeven) {
                rake = true;
                break;
              }
              else if (itemPrice > rakeFive && itemPrice < rakeSix) {
                rake = true;
                break;
              }
              else if (itemPrice > rakeFour && itemPrice < rakeFive) {
                rake = true;
                break;
              }
              else if (itemPrice > rakeThree && itemPrice < rakeFour) {
                rake = true;
                break;
              }
              else if (itemPrice > rakeTwo && itemPrice < rakeThree) {
                rake = true;
                break;
              } else {
                items.push(inventoryData[j]);
                inventoryData.splice(j, 1);
                break;
              }
            } else {
              items.push(inventoryData[j]);
              inventoryData.splice(j, 1);
              break;
            }
          }
        }
      }
      var trade = offers.createOffer(userInfo.winner.id);
      console.log('Here are the items I am giving the user', items);
      trade.addMyItems(items);
      trade.send('Thanks for playing, here are your winnings! Still feeling lucky? Play again!', userInfo.tradeToken, function(err, status) {
        if (err) {
          logger.log('info', err);
          offerError(err, userInfo, res, true);
        } else {
          res.json({status: 'Trade offer status: ' + status + ' trade ID: ' + trade.id});
        }
      });
    }
  });
};

offer_server.post('/user-withdraw', function(req, res) {
  console.log('CALLING BOT WITHDRAW', req.body);
  var userInfo = req.body;
  userWithdraw(userInfo, res);
});

// [if we dont receive a route we can handle]
offer_server.all('*', function(req, resp) {
  resp.type('application/json');
  resp.json({'error' : 'server error'});
  resp.end();
});


// ============================== UTILITY FUNCTIONS ====================================//

function offerError(err, userInfo, res, withdraw) {
  err = String(err);

  if (err.indexOf('401') > -1) {
    client.webLogOn();
    setTimeout(function() {
      if (withdraw) {
        console.log('Re-trying withdrawal');
        userWithdraw(userInfo, res);
      } else {
        console.log('Re-trying deposit');
        userDeposit(userInfo, res);
      }
    }, 10000);
  }
  else if (err.indexOf('20') > -1) {
    setTimeout(function() {
      console.log('Steam is down/delayed, trying to send offer again in 10 seconds');
      userWithdraw(userInfo, res);
    }, 10000);
  } else {
    console.log('error is ', err);
    userRef.child(userInfo.id).update({
      errorDetected: true
    });
  }
}

// ============================== Handle Fatal sudden termination ============================== //

function exitHandler(options, err) {
  process.stdin.resume(); // == so console dosnt close instantly == //
  if (options.cleanup) {
    options.server_handle.close();
  }

  if (err) {
    console.log(err.stack);
  }
  if (options.exit) {
    process.exit();
  }
}
