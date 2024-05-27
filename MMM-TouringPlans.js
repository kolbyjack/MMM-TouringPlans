// MMM-TouringPlans.js

Module.register("MMM-TouringPlans", {
  // Default module config
  defaults: {
    resort: "walt-disney-world",
    updateInterval: 60 * 60 * 1000,
    maximumEntries: 7,
    passType: "platinum",
  },

  start: function() {
    var self = this;

    self.forecast = [];
    self.getData();
    setInterval(function() { self.getData(); }, self.config.updateInterval);
  },

  notificationReceived: function(notification, payload, sender) {
    // Do nothing
  },

  socketNotificationReceived: function(notification, payload) {
    var self = this;

    if (notification === "TOURINGPLANS_FORECAST") {
      self.forecast = payload.slice(0, self.config.maximumEntries);
      self.updateDom();
    }
  },

  getData: function() {
    var self = this;

    self.sendSocketNotification("TOURINGPLANS_FETCH_FORECAST", self.config);
  },

  getDom: function() {
    var self = this;
    var table = document.createElement("table");
    var PARKS = ["MK", "EP", "HS", "AK", "UO", "IOA"];
    // http://www.perbang.dk/rgbgradient/ 3792f6..f42f91 HSV inverse
    var LEVEL_COLORS = [
      "",
      "#3792f6",
      "#36e7f5",
      "#35f5ae",
      "#34f557",
      "#66f533",
      "#bcf432",
      "#f4d631",
      "#f47e30",
      "#f42f39",
      "#f42f91",
    ];

    table.className = "normal small";
    table.style.width = "auto";

    var usedLevels = {};
    for (var i = 0; i < self.forecast.length; i++) {
      var day = self.forecast[i];
      var date = new Date(day.date);
      var row = document.createElement("tr");
      var cell = document.createElement("td");

      if (i <= 7) {
        cell.innerText = date.toLocaleDateString(config.language, { "weekday": "short", "timeZone": "UTC" });
      } else {
        cell.innerText = (date.getMonth() + 1) + "/" + date.getDate();
      }
      cell.style.width = "55px";
      row.appendChild(cell);

      for (var j = 0; j < PARKS.length; ++j) {
        if (!(PARKS[j] in day)) {
          continue;
        }

        cell = document.createElement("td");

        let level = day[PARKS[j]];
        if (level < 0) {
          cell.style.filter = "brightness(0.2)";
          level = -level;
        }
        cell.innerText = PARKS[j];
        cell.style.color = LEVEL_COLORS[level];
        cell.style["text-align"] = "center";
        cell.style.width = "55px";
        usedLevels[level] = true;

        row.appendChild(cell);
      }

      table.appendChild(row);
    }

    var row = document.createElement("tr");
    row.style["line-height"] = "12px";
    row.appendChild(document.createElement("td"));

    cell = document.createElement("td");
    cell.colSpan = "999";
    for (var i = 1; i <= 10; ++i) {
      var div = document.createElement("div");
      div.style = "width: 10%; display: inline-block; margin: 0px; padding: 0px; border: 0px;"
      div.style["background-color"] = LEVEL_COLORS[i];
      if (!usedLevels[i]) {
        div.style.filter = "brightness(0.2)";
      }
      div.innerHTML = "&nbsp;";
      cell.appendChild(div);
    }
    row.appendChild(cell);

    table.appendChild(row);

    return table;
  }
});
