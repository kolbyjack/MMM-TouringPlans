"use strict";

const NodeHelper = require("node_helper");
const request = require("request");
const htmlparser = require("htmlparser2");
const domutils = require("domutils");
const fs = require("fs");
const FileCookieStore = require("./filestore").FileCookieStore;

function sprintf(fmt) {
  var parts = fmt.split("{}");
  var message = parts[0];
  var i;

  for (i = 1; i < parts.length; ++i) {
    message += arguments[i] + parts[i];
  }

  return message;
}

class Logger {
  constructor() {
    this.level = this.Level.INFO;
  }

  _format_log_line(args) {
    function z(n) {
      return ((n < 10) ? "0" : "") + n;
    }
    var now = new Date();

    return sprintf("{}/{} {}:{}:{} - MMM-TouringPlans - {}", z(now.getMonth() + 1),
      z(now.getDate()), z(now.getHours()), z(now.getMinutes()), z(now.getSeconds()),
      sprintf.apply(this, args));
  }

  debug(fmt) {
    if (this.level <= this.Level.DEBUG) {
      console.log(this._format_log_line(arguments));
    }
  }

  log(fmt) {
    if (this.level <= this.Level.DEBUG) {
      console.log(this._format_log_line(arguments));
    }
  }

  info(fmt) {
    if (this.level <= this.Level.INFO) {
      console.info(this._format_log_line(arguments));
    }
  }

  warn(fmt) {
    if (this.level <= this.Level.WARN) {
      console.warn(this._format_log_line(arguments));
    }
  }

  error(fmt) {
    if (this.level <= this.Level.ERROR) {
      console.error(this._format_log_line(arguments));
    }
  }
}

Logger.prototype.Level = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  NONE: 4,
});

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
  return __dirname + "/" + filename;
}

module.exports = NodeHelper.create({
  start: function() {
    var self = this;
    var cookieFile = moduleFile("cookies.json");

    fs.closeSync(fs.openSync(cookieFile, "w"));

    self.logger = new Logger();
    self.debug = false;
    if (self.debug) {
      self.logger.level = self.logger.Level.DEBUG;
    }

    self.logger.info("Starting node helper");
    self.login_pending = false;
    self.fetch_pending = false;
    self.cache = { "forecast": [], "expires": Date.now() };
    self.jar = request.jar(new FileCookieStore(cookieFile));
  },

  socketNotificationReceived: function(notification, payload) {
    var self = this;

    if (notification === "TOURINGPLANS_FETCH_FORECAST") {
      self.fetchWaitTimes(payload);
    }
  },

  fetchWaitTimes: function(config) {
    var self = this;
    var now = Date.now();
    var today = new Date().toISOString().slice(0, 10).replace("-", "/");

    while (self.cache.forecast.length > 0 && self.cache.forecast[0].date !== today) {
      self.logger.log("Removing {} from cache", self.cache.forecast[0].date);
      self.cache.forecast = self.cache.forecast.slice(1);
    }

    if (now < self.cache.expires && config.maximumEntries <= self.cache.forecast.length) {
      self.logger.log("Sending cached forecast ({} ms remaining)", (self.cache.expires - now) | 0);
      self.sendSocketNotification("TOURINGPLANS_FORECAST", self.cache.forecast);
    } else {
      self.fetchData(config);
    }
  },

  fetchData: function(config) {
    var self = this;
    var url = "https://touringplans.com/walt-disney-world/crowd-calendar";

    if (self.debug && fs.existsSync(moduleFile("crowd-calendar.html"))) {
      self.processData(config, fs.readFileSync(moduleFile("crowd-calendar.html")));
      return;
    }

    if (self.fetch_pending) {
      return;
    }

    self.fetch_pending = true;
    if (self.jar.getCookies(url).length === 0) {
      self.fetchLoginPage(config);
      return;
    }

    self.logger.log("Fetching crowd calendar");
    request({
      url: url,
      method: "GET",
      headers: { "cache-control": "no-cache" },
      jar: self.jar,
    },
    function(error, response, body) {
      if (error) {
        self.sendSocketNotification("FETCH_ERROR", { error: error });
        self.fetch_pending = false;
        return logerror(error);
      }

      if (response.statusCode === 200) {
        if (self.debug) {
          fs.writeFileSync(moduleFile("crowd-calendar.html"), body);
        }
        self.processData(config, body);
        self.fetch_pending = false;
      }
    });
  },

  fetchLoginPage: function(config) {
    var self = this;
    var url = "https://touringplans.com/login";

    if (self.login_pending) {
      return;
    }

    self.login_pending = true;

    if (self.debug && fs.existsSync(moduleFile("crowd-calendar.html"))) {
      self.processLoginPage(config, fs.readFileSync(moduleFile("crowd-calendar.html")));
      return;
    }

    self.logger.log("Fetching login page");
    request({
      url: url,
      method: "GET",
      headers: { "cache-control": "no-cache" },
      jar: self.jar,
    },
    function(error, response, body) {
      if (error) {
        self.sendSocketNotification("TOURINGPLANS_LOGIN_ERROR", { error: error });
        self.login_pending = false;
        self.fetch_pending = false;
        return logerror(error);
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
          "user_session[password]": config.password
        };

        domutils.filter(e => e.type === "tag" && e.name === "input", form).map(function(input) {
          if (input.attribs.type === "hidden") {
            formData[input.attribs.name] = input.attribs.value;
          }
        });

        self.logger.log("Logging in");
        request({
          url: "https://touringplans.com/user_sessions",
          method: "POST",
          headers: { "cache-control": "no-cache" },
          form: formData,
          jar: self.jar,
        },
        function(error, response, body) {
          if (error) {
            self.sendSocketNotification("TOURINGPLANS_LOGIN_ERROR", { error: error });
            self.login_pending = false;
            self.fetch_pending = false;
            return logerror(error);
          }

          self.login_pending = false;
          self.fetch_pending = false;
          self.fetchData(config);
        });
      }
    });
  },

  processData: function(config, data) {
    var self = this;
    var dom = htmlparser.parseDOM(data);
    var forecast = [];

    domutils.filter(e => e.type === "tag" && e.name === "tr", dom).map(function(row) {
      var cells = row.children.filter(e => e.type === "tag" && e.name === "td");
      
      if (cells.length !== 8 || innerText(cells[0]).toLowerCase() === "date" || forecast.length >= 60) {
        return;
      }
      
      var date = new Date(innerText(cells[0]).split(" ").slice(0, 3).join(" "));
      forecast.push({
        date: date.toISOString().slice(0, 10).replace(/-/g, "/"),
        MK: +(innerText(cells[2]).split(" ")[0]),
        EP: +(innerText(cells[3]).split(" ")[0]),
        HS: +(innerText(cells[4]).split(" ")[0]),
        AK: +(innerText(cells[5]).split(" ")[0]),
      });
    });

    self.cache.forecast = forecast;
    self.cache.expires = Date.now() + config.updateInterval * 0.9;
    self.logger.log("{} entries in forecast cache, expires in {}ms", forecast.length,
      self.cache.expires - Date.now());
    self.sendSocketNotification("TOURINGPLANS_FORECAST", self.cache.forecast);
  },
});
