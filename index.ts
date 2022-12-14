import * as crypto from "crypto-js";
import * as fs from "fs";
import * as moment from "moment-timezone";
import * as schedule from "node-schedule";

import { Amtrak, RawStation } from "./amtrak";
import { Train, Station, StationStatus } from "./amtraker";

import * as trainMetaData from "./data/trains";
import * as stationMetaData from "./data/stations";
import cache from "./cache";

const trainUrl =
  "https://maps.amtrak.com/services/MapDataService/trains/getTrainsData";
const stationUrl =
  "https://maps.amtrak.com/services/MapDataService/stations/trainStations";
const sValue = "9a3686ac";
const iValue = "c6eb2f7f5c4740c1a2f708fefd947d39";
const publicKey = "69af143c-e8cf-47f8-bf09-fc1f61e5cc33";
const masterSegment = 88;

const amtrakerCache = new cache();

const decrypt = (content, key) => {
  return crypto.AES.decrypt(
    crypto.lib.CipherParams.create({
      ciphertext: crypto.enc.Base64.parse(content),
    }),
    crypto.PBKDF2(key, crypto.enc.Hex.parse(sValue), {
      keySize: 4,
      iterations: 1e3,
    }),
    { iv: crypto.enc.Hex.parse(iValue) }
  ).toString(crypto.enc.Utf8);
};

const fetchTrainsForCleaning = async () => {
  const response = await fetch(trainUrl);
  const data = await response.text();

  const mainContent = data.substring(0, data.length - masterSegment);
  const encryptedPrivateKey = data.substr(
    data.length - masterSegment,
    data.length
  );
  const privateKey = decrypt(encryptedPrivateKey, publicKey).split("|")[0];
  return JSON.parse(decrypt(mainContent, privateKey)).features;
};

const fetchStationsForCleaning = async () => {
  const response = await fetch(stationUrl);
  const data = await response.text();

  const mainContent = data.substring(0, data.length - masterSegment);
  const encryptedPrivateKey = data.substr(
    data.length - masterSegment,
    data.length
  );
  const privateKey = decrypt(encryptedPrivateKey, publicKey).split("|")[0];
  return JSON.parse(decrypt(mainContent, privateKey)).StationsDataResponse
    .features;
};

const parseDate = (badDate: string | null, code: string | null) => {
  if (badDate == null || code == null) return null;

  try {
    let fixedDate = moment(badDate, [
      "MM-DD-YYYY HH:mm:ss",
      "MM-DD-YYYY hh:mm:ss A",
    ]).tz(stationMetaData.timeZones[code][0] ?? "");
    if (fixedDate.isValid()) {
      return fixedDate.format();
    } else {
      console.log("date was not valid for", code);
      return null;
    }
  } catch (e) {
    console.log("Couldn't parse date:", badDate, code);
    return null;
  }
};

const generateCmnt = (
  scheduledDate: string,
  actualDate: string,
  code: string
) => {
  let parsedScheduledDate = parseDate(scheduledDate, code);
  let parsedActualDate = parseDate(actualDate, code);
  let earlyOrLate = moment(parsedScheduledDate).isBefore(parsedActualDate)
    ? "Late"
    : "Early";

  let diff = moment(parsedActualDate).diff(parsedScheduledDate);

  let duration = moment.duration(diff);
  let hrs = duration.hours(),
    mins = duration.minutes();

  let string = (hrs > 0 ? hrs + " Hours, " : "") + (mins + " Minutes ");

  if (mins < 5 && earlyOrLate === "Late") {
    return "On Time";
  } else {
    return string + earlyOrLate;
  }
};

const parseRawStation = (rawStation: RawStation) => {
  let status: StationStatus;
  let arr: string;
  let dep: string;
  let arrCmnt: string;
  let depCmnt: string;

  if (rawStation.estarr == null && rawStation.postarr == null) {
    // is this the first station
    if (rawStation.postdep != null) {
      // if the train has departed
      status = StationStatus.Departed;
      dep = parseDate(rawStation.postdep, rawStation.code);
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.postdep,
        rawStation.code
      );
    } else {
      // if the train hasn't departed
      status = StationStatus.Station;
      dep = parseDate(rawStation.estdep, rawStation.code);
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.estdep,
        rawStation.code
      );
    }
  } else if (rawStation.postarr == null && rawStation.postdep == null) {
    // is this the last station
    if (rawStation.postarr != null) {
      // if the train has arrived
      status = StationStatus.Station;
      arr = parseDate(rawStation.postarr, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr,
        rawStation.postarr,
        rawStation.code
      );
    } else {
      // if the train is enroute
      status = StationStatus.Enroute;
      arr = parseDate(rawStation.estarr, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr,
        rawStation.estarr,
        rawStation.code
      );
    }
  } else {
    // for all other stations
    if (rawStation.estarr != null && rawStation.estdep != null) {
      // if the train is enroute
      status = StationStatus.Enroute;
      arr = parseDate(rawStation.estarr, rawStation.code);
      dep = parseDate(rawStation.estdep, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr ?? rawStation.schdep,
        rawStation.estarr,
        rawStation.code
      );
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.estdep,
        rawStation.code
      );
    } else if (rawStation.postarr != null && rawStation.estdep != null) {
      // if the train has arrived but not departed
      status = StationStatus.Station;
      arr = parseDate(rawStation.postarr, rawStation.code);
      dep = parseDate(rawStation.estdep, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr ?? rawStation.schdep,
        rawStation.postarr,
        rawStation.code
      );
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.estdep,
        rawStation.code
      );
    } else if (rawStation.postdep != null) {
      // if the train has departed
      status = StationStatus.Departed;
      arr = parseDate(rawStation.postarr, rawStation.code);
      dep = parseDate(rawStation.postdep, rawStation.code);
      arrCmnt = generateCmnt(
        rawStation.scharr ?? rawStation.schdep,
        rawStation.postarr,
        rawStation.code
      );
      depCmnt = generateCmnt(
        rawStation.schdep,
        rawStation.postdep,
        rawStation.code
      );
    }
  }

  return {
    name: stationMetaData.stationNames[rawStation.code],
    code: rawStation.code,
    tz: stationMetaData.timeZones[rawStation.code],
    bus: rawStation.bus,
    schArr: parseDate(rawStation.scharr, rawStation.code),
    schDep: parseDate(rawStation.schdep, rawStation.code),
    arr: arr,
    dep: dep,
    arrCmnt: arrCmnt,
    depCmnt: depCmnt,
    status: status,
  } as Station;
};

const updateTrains = async () => {
  console.log("Updating trains...");
  fetchTrainsForCleaning()
    .then((amtrakData) => {
      let trains: { [key: string]: Train[] } = {};

      amtrakData.forEach((property) => {
        let rawTrainData = property.properties;

        let rawStations: Array<RawStation> = [];

        for (let i = 1; i < 41; i++) {
          let station = rawTrainData[`Station${i}`];
          if (station == undefined) {
            continue;
          } else {
            try {
              let rawStation = JSON.parse(station);
              if (rawStation.code === "CBN") continue;
              rawStations.push(rawStation);
            } catch (e) {
              console.log("Error parsing station:", e);
              continue;
            }
          }
        }

        let stations = rawStations.map((station) => parseRawStation(station));

        let train: Train = {
          routeName: rawTrainData.RouteName,
          trainNum: +rawTrainData.TrainNum,
          stations: stations,
          heading: rawTrainData.Heading,
          eventCode: rawTrainData.EventCode,
          origCode: rawTrainData.OrigCode,
          originTZ: stationMetaData.timeZones[rawTrainData.OrigCode],
          destCode: rawTrainData.DestCode,
          destTZ: stationMetaData.timeZones[rawTrainData.DestCode],
          trainState: rawTrainData.TrainState,
          velocity: +rawTrainData.Velocity,
          statusMsg: rawTrainData.StatusMsg,
          createdAt: parseDate(rawTrainData.created_at, rawTrainData.EventCode),
          updatedAt: parseDate(rawTrainData.updated_at, rawTrainData.EventCode),
          lastValTS: parseDate(rawTrainData.LastValTS, rawTrainData.EventCode),
          objectID: rawTrainData.OBJECTID,
        };

        trains[rawTrainData.TrainNum] = trains[rawTrainData.TrainNum] || [];
        trains[rawTrainData.TrainNum].push(train);
      });

      amtrakerCache.set("trains", trains);
    })
    .catch((e) => {
      console.log("Error fetching train data:", e);
    });
};

// updateTrains();

schedule.scheduleJob("*/3 * * * *", updateTrains);

Bun.serve({
  port: 3000,
  fetch(request) {
    let data = amtrakerCache.get("trains");
    return new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json;charset=UTF-8",
      },
    });
  },
});
