"use strict";

const NodeHelper = require("node_helper");
const request = require("request");
const htmlparser = require("htmlparser2");
const domutils = require("domutils");
const fs = require("fs");
const FileCookieStore = require("tough-cookie-file-store").FileCookieStore;

const cacheFilename = "forecast-cache.json";

function z(n) {
  return ((n < 10) ? "0" : "") + n;
}

function msToHMS(ms) {
  const hr = (ms / 3600000) | 0;
  const min = ((ms / 60000) % 60) | 0;
  const sec = ((ms * 0.001) % 60) | 0;

  return `${hr}:${z(min)}:${z(sec)}`;
}

function innerText(element) {
  function innerInnerText(el) {
    let result = "";

    for (let i in el.children) {
      const child = el.children[i];

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

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

module.exports = NodeHelper.create({
  start: function() {
    const self = this;
    const cookieFile = moduleFile("cookies.json");

    fs.closeSync(fs.openSync(cookieFile, "w"));

    self.debug = false;

    self.loginPending = false;
    self.forecastFetchPending = {};
    self.blockoutFetchPending = false;
    self.cache = {};
    self.blockoutData = {};
    self.jar = request.jar(new FileCookieStore(cookieFile));

    if (fs.existsSync(moduleFile(cacheFilename))) {
      self.cache = JSON.parse(fs.readFileSync(moduleFile(cacheFilename)));
      for (let [resort, data] of Object.entries(self.cache)) {
        console.log(`${data.forecast.length} entries in ${resort} forecast cache, expires in ${msToHMS(data.expires - Date.now())}`);
      }
    }

    if (fs.existsSync(moduleFile("blockout-data.json"))) {
      self.blockoutData = JSON.parse(fs.readFileSync(moduleFile("blockout-data.json")));
    }
  },

  socketNotificationReceived: function(notification, payload) {
    const self = this;

    if (notification === "TOURINGPLANS_FETCH_FORECAST") {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
      for (let [resort, data] of Object.entries(self.cache)) {
        while (data.forecast.length > 0 && data.forecast[0].date !== today) {
          console.log(`Removing ${data.forecast[0].date} from ${resort} cache`);
          data.forecast = data.forecast.slice(1);
        }
      }

      for (let resort of asArray(payload.resort)) {
        self.fetchForecast(resort, payload);
      }
    }
  },

  fetchForecast: function(resort, config) {
    const self = this;
    const now = Date.now();
    const cache = self.cache[resort] || { "forecast": [], "expires": Date.now() };

    console.log(`Fetching forecast for ${resort}`);
    if (now < cache.expires && config.maximumEntries <= cache.forecast.length) {
      console.log(`Sending cached ${resort} forecast, expires in ${msToHMS(cache.expires - now)}`);
      self.sendForecast();
    } else {
      self.fetchCrowdData(resort, config);
      if (resort === "walt-disney-world") {
        self.fetchBlockoutData();
      }
    }
  },

  fetchCrowdData: function(resort, config) {
    const self = this;
    const now = new Date();
    const url = `https://touringplans.com/${resort}/crowd-calendar?calendar[month]=${now.getMonth() + 1}&calendar[year]=${now.getFullYear()}&calendar[list]=true&button=`;
    const debugFile = moduleFile(`${resort}-crowd-calendar.html`);

    if (self.debug && fs.existsSync(debugFile)) {
      self.processCrowdCalendar(resort, config, fs.readFileSync(debugFile));
      return;
    }

    if (self.forecastFetchPending[resort]) {
      return;
    }

    self.forecastFetchPending[resort] = true;
    if (self.jar.getCookies(url).length === 0) {
      self.fetchLoginPage(config);
      return;
    }

    console.log(`Fetching ${resort} crowd calendar`);
    self.request(url, (error, response, body) => {
      self.forecastFetchPending[resort] = false;

      if (error) {
        self.sendSocketNotification("FETCH_ERROR", { error: error });
        return console.error(error);
      }

      if (response.statusCode === 200) {
        if (self.debug) {
          fs.writeFileSync(debugFile, body);
        }
        self.processCrowdCalendar(resort, config, body);
      }
    });
  },

  fetchLoginPage: function(config) {
    const self = this;
    const url = "https://touringplans.com/login";
    const debugFile = moduleFile("login.html");

    if (self.loginPending) {
      return;
    }

    self.loginPending = true;

    if (self.debug && fs.existsSync(debugFile)) {
      self.processLoginPage(config, fs.readFileSync(debugFile));
      return;
    }

    console.log("Fetching login page");
    self.request(url, (error, response, body) => {
      if (error) {
        self.sendSocketNotification("TOURINGPLANS_LOGIN_ERROR", { error: error });
        self.loginPending = false;
        self.forecastFetchPending = {};
        return console.error(error);
      }

      if (response.statusCode === 200) {
        if (self.debug) {
          fs.writeFileSync(debugFile, body);
        }
        self.processLoginPage(config, body);
      }
    });
  },

  processLoginPage: function(config, body) {
    const self = this;
    const dom = htmlparser.parseDOM(body);

    domutils.filter(e => e.type === "tag" && e.name === "form", dom).map(function(form) {
      if (form.attribs.class === "new_user_session") {
        const formData = {
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

          if (error) {
            self.sendSocketNotification("TOURINGPLANS_LOGIN_ERROR", { error: error });
            self.forecastFetchPending = {};
            return console.error(error);
          }

          for (let resort in self.forecastFetchPending) {
            self.forecastFetchPending[resort] = false;
            self.fetchCrowdData(resort, config);
          }
        });
      }
    });
  },

  processCrowdCalendar: function(resort, config, data) {
    const self = this;
    const dom = htmlparser.parseDOM(data);
    const forecast = [];
    const columns = {
      "walt-disney-world": 8,
      "universal-orlando": 6,
    };

    domutils.filter(e => e.type === "tag" && e.name === "tr", dom).map(function(row) {
      const cells = row.children.filter(e => e.type === "tag" && e.name === "td");

      if (cells.length !== columns[resort]
          || innerText(cells[0]).toLowerCase() === "date"
          || forecast.length >= 60) {
        return;
      }

      const date = row.attribs["data-date"];
      const o = { date: date };
      if (resort === "walt-disney-world") {
        o.MK = +(innerText(cells[2]).split(" ")[0]);
        o.EP = +(innerText(cells[3]).split(" ")[0]);
        o.HS = +(innerText(cells[4]).split(" ")[0]);
        o.AK = +(innerText(cells[5]).split(" ")[0]);
      } else if (resort === "universal-orlando") {
        o.UO = +(innerText(cells[2]).split(" ")[0]);
        o.IOA = +(innerText(cells[3]).split(" ")[0]);
      }

      forecast.push(o);
    });

    self.applyBlockoutData(forecast, config);
    const cache = self.cache[resort] = {
      "forecast": forecast,
      "expires": (new Date()).setUTCHours(30, 0, 0, 0),
    };
    fs.writeFileSync(moduleFile(cacheFilename), JSON.stringify(self.cache));
    console.log(`${cache.forecast.length} entries in ${resort} forecast cache, expires in ${msToHMS(cache.expires - Date.now())}`);
    self.sendForecast();
  },

  fetchBlockoutData: function(config) {
    const self = this;
    const url = "https://disneyworld.disney.go.com/passes/blockout-dates/api/get-calendars/?months=3";

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
    const self = this;
    const json = JSON.parse(data);
    const blockoutData = {};
    const parkMap = {
      "80007838": "EP",
      "80007998": "HS",
      "80007944": "MK",
      "80007823": "AK",
    };

    for (let [passId, passData] of Object.entries(json.entries)) {
      const passName = passId.substr(4).toLowerCase();

      for (let [parkId, calendarData] of Object.entries(passData.calendars)) {
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
    const self = this;

    if (self.debug) {
      console.log(message);
    }
  },

  applyBlockoutData: function(forecast, config) {
    const self = this;

    for (let day of forecast) {
      for (let [park, level] of Object.entries(day)) {
        if (!Number.isInteger(level)) {
          continue;
        }
        const key = `${day.date}::${config.passType}::${park}`;
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

  sendForecast: function() {
    const self = this;
    const forecast = [];

    for (let [resort, data] of Object.entries(self.cache)) {
      for (let i = 0; i < data.forecast.length; ++i) {
        if (i == forecast.length) {
          forecast.push(data.forecast[i]);
        } else if (data.forecast[i].date === forecast[i].date) {
          Object.assign(forecast[i], data.forecast[i]);
        } else {
          console.error(`Date mismatch at index ${i}: ${forecast[i].date} vs ${data.forecast[i].date}`);
        }
      }
    }

    self.sendSocketNotification("TOURINGPLANS_FORECAST", forecast);
  },
});
