const _ = require('lodash/fp');
const Database = require('better-sqlite3');
const echarts = require('node-echarts');
const moment = require('moment');
const jieba = require("nodejieba");

const ROOM = '6624467079@chatroom';

function parseMsg(m) {
  if (!m.content) {
    return {
      user: '',
      content: '',
      date: moment(m.createTime)
    }
  }
  const splitPos = m.content.indexOf(':');
  const user = m.content.substr(0, splitPos);
  const content = m.content.substr(splitPos + 1).trim();
  return {
    user,
    content,
    date: moment(m.createTime)
  }
}

class BufferReader {

  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  read(size) {
    if (size === 1) {
      const byte = this.buffer.readInt8(this.offset);
      this.offset++;
      return byte;
    } else {
      const s = this.buffer.toString('utf-8', this.offset, this.offset + size);
      this.offset += size;
      return s;
    }
  }

  readAdvanceByte(adv) {
    return this.buffer.readInt8(this.offset + adv);
  }
}


function parseChatroomNicknames(data) {
  const buffer = new BufferReader(data);

  function readName() {

    /**
     * Find pattern: 0A XX 0A NN
     * Return NN which is the length of following name
     */
    function findStart() {
      do {
        while (buffer.read(1) != 0x0a) { }
      } while (buffer.readAdvanceByte(1) !== 0x0a);
      buffer.read(2);
      return buffer.read(1);
    }

    return buffer.read(findStart());
  }

  function readNickname() {
    if (buffer.read(1) !== 0x12) {
      return undefined;
    }
    const length = buffer.read(1);
    return buffer.read(length);
  }

  const result = [];

  try {
    while (true) {
      result.push([readName(), readNickname()]);
    }
  } catch (err) {
    if (err instanceof RangeError) {
      return result;
    } else {
      throw err;
    }
  }
}

// Get top N talkers per period
function topTalkers(topN, periodFn) {
  return _.flow(
    _.groupBy(msg => periodFn(msg.date)),
    _.mapValues(_.flow(
      _.groupBy('user'),
      _.mapValues('length'),
      _.toPairs,
      _.sortBy(1),
      _.takeRight(topN)
    ))
  );
}

function countMsgPerTalker(talkers, periodFn) {
  return _.flow(
    _.filter(msg => _.includes(msg.user, talkers)),
    _.groupBy('user'),
    _.mapValues(_.flow(
      _.countBy(msg => periodFn(msg.date)),
      _.toPairs,
    )),
    _.toPairs,
    _.filter(([name, data]) => data.length > 0),
  );
}

function wordList(periodFn) {
  return _.flow(
    _.groupBy(msg => periodFn(msg.date)),
    _.mapValues(_.flow(
      _.flatMap(msg => jieba.extract(msg.content, 10)),
      _.map('word'),
      // _.each(print),
      _.countBy(_.identity),
      _.toPairs,
      _.filter(([word, number]) => word.length > 1),
      _.sortBy(_.flow(_.tail, parseInt)),
      _.reverse,
      _.take(20),
    )),
  );
}


function userHeatmap(talkers) {

  function maxValue(data) {
    return _.flow(
      _.map(_.last),
      _.max,
    )(data);
  }

  function chart([user, data]) {
    echarts({
      width: 500,
      height: 400,
      path: `./output/${usernames[user].substr(0, 3)}.png`,
      option: {
        title: {
          text: usernames[user]
        },
        xAxis: {
          type: 'category',
          data: ['12a', '1a', '2a', '3a', '4a', '5a', '6a', '7a', '8a', '9a', '10a', '11a',
            '12p', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '10p', '11p'],
          splitArea: {
            interval: 0,
            show: true
          }
        },
        yAxis: {
          type: 'category',
          data: ['Saturday', 'Friday', 'Thursday', 'Wednesday', 'Tuesday', 'Monday', 'Sunday'],
          splitArea: {
            interval: 0,
            show: true
          }
        },
        visualMap: {
          show: false,
          min: 0,
          max: 50, //maxValue(data),
          color: ['orangered','yellow','lightskyblue'],
        },
        series: [{
          type: 'heatmap',
          data: data,
          label: {
            normal: {
              show: true
            }
          },
        }]
      }
    }).catch(console.log);
  }

  const period = (moment) => `${moment.hour()}-${moment.day()}`;
  return _.flow(
    countMsgPerTalker(talkers, period),
    _.fromPairs,
    _.mapValues(
      _.map(([idx, n]) => _.flatten([idx.split('-').map(v => Number(v)), n]))
    ),
    _.toPairs,
    _.each(chart)
  );
}

function print(...obj) {
  console.log('-------------------');
  console.log(...obj);
}

// ========== main ============

const db = new Database('./decrypted.db', { readonly: true, fileMastExist: true });

const userMap = _.flow(
  _.keyBy('username'),
  _.mapValues('nickname')
)(db.prepare('SELECT username, nickname FROM rcontact').all());

const { roomdata } = db.prepare('SELECT roomdata FROM chatroom WHERE chatroomname=?').get(ROOM);
const nicknameMap = _.fromPairs(parseChatroomNicknames(roomdata));
const usernames = _.defaults(userMap, nicknameMap);

// type: 1-text, 3-image, 43-?, 47-emoji, 49-shared content, 10000-draw back, 268435505-app msg
const messages = _.map(parseMsg)(
  db.prepare('SELECT content, createTime, type FROM message WHERE talker=? AND type IN (1,3,49) LIMIT 10000000').all(ROOM)
);

// period of 10 days (3 periods in one month)
const period = (moment) => {
  return moment.month() * 3 + parseInt(moment.date() / 10);
};

// period of quarter
const periodQuarter = (moment) => {
  return moment.quarter();
};

// TODO: word splitting

// const words = wordList(period)(messages);
// print(words);
// process.exit();

// list of all top N talkers per period
const talkers = _.flow(
  _.mapValues(
    _.map(_.head),
  ),
  _.toPairs,
  _.map(_.tail),
  _.flattenDeep,
  _.uniq
)(topTalkers(5, period)(messages));


const out = countMsgPerTalker(talkers, period)(messages);

// print(out);
// console.log(JSON.stringify(out));

echarts({
  width: 800,
  height: 1000,
  path: './output/toptalker.png',
  option: {
    backgroundColor: '#fff',
    color: ['#7cb5ec', '#434348', '#90ed7d', '#f7a35c', '#8085e9',
      '#f15c80', '#e4d354', '#8085e8', '#8d4653', '#91e8e1'],
    xAxis: {
      type: 'value',
      interval: 1,
      axisLabel: {
        formatter: (value) => {
          return (value % 3) ? '' : 1 + value / 3;
        }
      }
    },
    yAxis: {
      type: 'value',
    },
    series: _.map(([name, data]) => {
      return {
        name: usernames[name],
        data,
        type: 'line',
        smooth: true,
      }
    })(out),
    legend: {
      data: _.flow(
        _.map(_.head),
        _.map(name => usernames[name]),
        _.uniq
      )(out)
    }
  }
}).catch(console.log);



userHeatmap(talkers)(messages);
