// MMM-TouringPlans.js

Module.register("MMM-TouringPlans", {
  // Default module config
  defaults: {
    updateInterval: 60 * 60 * 1000,
    maximumEntries: 7,
  },

  start: function() {
    var self = this;

    self.forecast = [];
    self.getData();
    setInterval(function() { self.getData(); }, self.config.updateInterval);
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
    var PARKS = ["MK", "EP", "HS", "AK"];
    // http://www.perbang.dk/rgbgradient/ 37f637..f42f2f HSV inverse
    var LEVEL_COLORS = [
      "",
      "#37f637",
      "#60f536",
      "#8af535",
      "#b4f534",
      "#dff533",
      "#f4df32",
      "#f4b331",
      "#f48730",
      "#f45b2f",
      "#f42f2f",
    ];

    table.className = "normal small";
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
      row.appendChild(cell);

      for (var j = 0; j < PARKS.length; ++j) {
        cell = document.createElement("td");

        cell.innerText = PARKS[j];
        cell.style.color = LEVEL_COLORS[day[PARKS[j]]];

        row.appendChild(cell);
      }

      table.appendChild(row);
    }

    return table;
  }
});
