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
    var wrapper = document.createElement("div");
    var table = document.createElement("table");
    var PARKS = ["MK", "EP", "HS", "AK"];
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
      row.appendChild(cell);

      for (var j = 0; j < PARKS.length; ++j) {
        cell = document.createElement("td");

        cell.innerText = PARKS[j];
        cell.style.color = LEVEL_COLORS[day[PARKS[j]]];
        usedLevels[day[PARKS[j]]] = true;

        row.appendChild(cell);
      }

      table.appendChild(row);
    }

    var row = document.createElement("tr");
    row.style["line-height"] = "12px";
    row.appendChild(document.createElement("td"));

    cell = document.createElement("td");
    cell.colSpan = "4";
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
    wrapper.appendChild(table);

    wrapper.style.width = "16ex";

    return wrapper;
  }
});
