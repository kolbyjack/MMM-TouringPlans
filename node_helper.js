"use strict";

const NodeHelper = require("node_helper");
const request = require("request");
const htmlparser = require("htmlparser2");
const domutils = require("domutils");
const fs = require("fs");
const FileCookieStore = require("tough-cookie-file-store").FileCookieStore;

function z(n) {
  return ((n < 10) ? "0" : "") + n;
}

function msToHMS(ms) {
  var hr = (ms / 3600000) | 0;
  var min = ((ms / 60000) % 60) | 0;
  var sec = ((ms * 0.001) % 60) | 0;

  return `${hr}:${z(min)}:${z(sec)}`;
}

function innerText(element) {
  function innerInnerText(el) {
    var result = "";

    for (var i in el.children) {
      var child = el.children[i];

      if (child.type === "text") {
        result += child.data;
      } else if (child.type === "tag") {
        result += " " + innerInnerText(child);
      }
    }

    return result.trim();
  }

  return innerInnerText(element).trim().replace(/\s+/g, " ");
}

function moduleFile(filename) {
  return `${__dirname}/${filename}`;
}

module.exports = NodeHelper.create({
  start: function() {
    var self = this;
    var cookieFile = moduleFile("cookies.json");

    fs.closeSync(fs.openSync(cookieFile, "w"));

    self.debug = false;

    self.loginPending = false;
    self.forecastFetchPending = false;
    self.blockoutFetchPending = false;
    self.cache = { "resort": null, "forecast": [], "expires": Date.now() };
    self.blockoutData = {};
    self.jar = request.jar(new FileCookieStore(cookieFile));

    if (fs.existsSync(moduleFile("crowd-calendar.json"))) {
      self.cache = JSON.parse(fs.readFileSync(moduleFile("crowd-calendar.json")));
      console.log(`${self.cache.forecast.length} entries in forecast cache, expires in ${msToHMS(self.cache.expires - Date.now())}`);
    }

    if (fs.existsSync(moduleFile("blockout-data.json"))) {
      self.blockoutData = JSON.parse(fs.readFileSync(moduleFile("blockout-data.json")));
    }
  },

  socketNotificationReceived: function(notification, payload) {
    var self = this;

    if (notification === "TOURINGPLANS_FETCH_FORECAST") {
      self.fetchForecast(payload);
    }
  },

  fetchForecast: function(config) {
    var self = this;
    var now = Date.now();
    var today = new Date().toISOString().slice(0, 10).replace(/-/g, "/");

    while (self.cache.forecast.length > 0 && self.cache.forecast[0].date !== today) {
      console.log(`Removing ${self.cache.forecast[0].date} from cache`);
      self.cache.forecast = self.cache.forecast.slice(1);
    }

    if (now < self.cache.expires && config.maximumEntries <= self.cache.forecast.length && config.resort === self.cache.resort) {
      console.log(`Sending cached forecast, expires in ${msToHMS(self.cache.expires - now)}`);
      self.sendSocketNotification("TOURINGPLANS_FORECAST", self.cache.forecast);
    } else {
      self.fetchCrowdData(config);
      if (config.resort === "walt-disney-world") {
        self.fetchBlockoutData();
      }
    }
  },

  fetchCrowdData: function(config) {
    var self = this;
    const now = new Date();
    const url = `https://touringplans.com/${config.resort}/crowd-calendar?calendar[month]=${now.getMonth() + 1}&calendar[year]=${now.getFullYear()}&calendar[list]=true&button=`;

    if (self.debug && fs.existsSync(moduleFile("crowd-calendar.html"))) {
      self.processCrowdCalendar(config, fs.readFileSync(moduleFile("crowd-calendar.html")));
      return;
    }

    if (self.forecastFetchPending) {
      return;
    }

    self.forecastFetchPending = true;
    if (self.jar.getCookies(url).length === 0) {
      self.fetchLoginPage(config);
      return;
    }

    console.log("Fetching crowd calendar");
    self.request(url, (error, response, body) => {
      self.forecastFetchPending = false;

      if (error) {
        self.sendSocketNotification("FETCH_ERROR", { error: error });
        return console.error(error);
      }

      if (response.statusCode === 200) {
        if (self.debug) {
          fs.writeFileSync(moduleFile("crowd-calendar.html"), body);
        }
        self.processCrowdCalendar(config, body);
      }
    });
  },

  fetchLoginPage: function(config) {
    var self = this;
    var url = "https://touringplans.com/login";

    if (self.loginPending) {
      return;
    }

    self.loginPending = true;

    if (self.debug && fs.existsSync(moduleFile("crowd-calendar.html"))) {
      self.processLoginPage(config, fs.readFileSync(moduleFile("crowd-calendar.html")));
      return;
    }

    console.log("Fetching login page");
    self.request(url, (error, response, body) => {
      if (error) {
        self.sendSocketNotification("TOURINGPLANS_LOGIN_ERROR", { error: error });
        self.loginPending = false;
        self.forecastFetchPending = false;
        return console.error(error);
      }

      if (response.statusCode === 200) {
        if (self.debug) {
          fs.writeFileSync(moduleFile("login.html"), body);
        }
        self.processLoginPage(config, body);
      }
    });
  },

  processLoginPage: function(config, body) {
    var self = this;
    var dom = htmlparser.parseDOM(body);

    domutils.filter(e => e.type === "tag" && e.name === "form", dom).map(function(form) {
      if (form.attribs.class === "new_user_session") {
        var formData = {
          "user_session[login]": config.username,
          "user_session[password]": config.password,
          "commit": "Log In"
        };

        domutils.filter(e => e.type === "tag" && e.name === "input", form).map(function(input) {
          if (input.attribs.type === "hidden") {
            formData[input.attribs.name] = input.attribs.value;
          }
        });

        console.log("Logging in");
        self.request("https://touringplans.com/user_sessions", formData, (error, response, body) => {
          self.loginPending = false;
          self.forecastFetchPending = false;

          if (error) {
            self.sendSocketNotification("TOURINGPLANS_LOGIN_ERROR", { error: error });
            return console.error(error);
          }

          self.fetchCrowdData(config);
        });
      }
    });
  },

  processCrowdCalendar: function(config, data) {
    var self = this;
    var dom = htmlparser.parseDOM(data);
    var forecast = [];
    const columns = {
      "walt-disney-world": 8,
      "universal-orlando": 6,
    };

    domutils.filter(e => e.type === "tag" && e.name === "tr", dom).map(function(row) {
      var cells = row.children.filter(e => e.type === "tag" && e.name === "td");

      if (cells.length !== columns[config.resort]
          || innerText(cells[0]).toLowerCase() === "date"
          || forecast.length >= 60) {
        return;
      }

      const date = row.attribs["data-date"];
      const o = { date: date };
      if (config.resort === "walt-disney-world") {
        o.MK = +(innerText(cells[2]).split(" ")[0]);
        o.EP = +(innerText(cells[3]).split(" ")[0]);
        o.HS = +(innerText(cells[4]).split(" ")[0]);
        o.AK = +(innerText(cells[5]).split(" ")[0]);
      } else if (config.resort === "universal-orlando") {
        o.UO = +(innerText(cells[2]).split(" ")[0]);
        o.IOA = +(innerText(cells[3]).split(" ")[0]);
      }

      forecast.push(o);
    });

    applyBlockoutData(forecast, config);
    self.cache.resort = config.resort;
    self.cache.forecast = forecast;
    self.cache.expires = (new Date()).setUTCHours(30, 0, 0, 0);
    fs.writeFileSync(moduleFile("crowd-calendar.json"), JSON.stringify(self.cache));
    console.log(`${self.cache.forecast.length} entries in forecast cache, expires in ${msToHMS(self.cache.expires - Date.now())}`);
    self.sendSocketNotification("TOURINGPLANS_FORECAST", self.cache.forecast);
  },

  fetchBlockoutData: function(config) {
    var self = this;
    var url = "https://disneyworld.disney.go.com/passes/blockout-dates/api/get-calendars/?months=3";

    if (self.blockoutFetchPending === true) {
      return;
    }

    self.blockoutFetchPending = true;
    self.request(url, (error, response, body) => {
      if (error) {
        self.sendSocketNotification("FETCH_ERROR", { error: error });
        self.blockoutFetchPending = false;
        return logerror(error);
      }

      if (response.statusCode === 200) {
        self.processBlockoutData(config, body);
        self.blockoutFetchPending = false;
      }
    });
  },

  processBlockoutData: function(config, data) {
    var self = this;
    var json = JSON.parse(data);
    var blockoutData = {};
    const parkMap = {
      "80007838": "EP",
      "80007998": "HS",
      "80007944": "MK",
      "80007823": "AK",
    };

    for (var [passId, passData] of Object.entries(json.entries)) {
      var passName = passId.substr(4).toLowerCase();

      for (var [parkId, calendarData] of Object.entries(passData.calendars)) {
        if (!(parkId in parkMap)) {
          continue;
        }

        const parkName = parkMap[parkId];
        calendarData.blockoutDates.map(date => {
          const key = `${date.replace(/-/g, "/")}::${passName}::${parkName}`;
          blockoutData[key] = true;
        });
      }
    }

    self.blockoutData = blockoutData;
    fs.writeFileSync(moduleFile("blockout-data.json"), JSON.stringify(self.blockoutData));
  },

  log: function(message) {
    var self = this;

    if (self.debug) {
      console.log(message);
    }
  },

  applyBlockoutData: function(forecast, config) {
    const self = this;

    for (let day of forecast) {
      for (let [park, level] of Object.entries(day)) {
        const key = `${day.date}::${config.passType}::${park}`;
        console.log(`Checking blockoutData[${key}]`);
        if (self.blockoutData[key]) {
          day[park] = -Math.abs(level);
        } else {
          day[park] = Math.abs(level);
        }
      }
    }
  },

  request: function(url, body, callback) {
    const self = this;
    const params = {
      url: url,
      method: "GET",
      headers: {
        "Cache-Control": "no-cache",
        "User-Agent": "MMM-TouringPlans",
      },
      jar: self.jar,
    };

    if (callback === undefined) {
      callback = body;
      body = null;
    }

    if (body) {
      params.method = "POST";
      params.form = body;
    }

    request(params, callback);
  },
});
