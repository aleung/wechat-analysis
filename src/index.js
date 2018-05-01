const _ = require('lodash/fp');
const Database = require('better-sqlite3');
const echarts = require('node-echarts');
const moment = require('moment');

const ROOM = '6624467079@chatroom';

function parseMsg(m) {
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
      // console.log('Read byte at pos', this.offset, byte.toString(16));
      this.offset++;
      return byte;
    } else {
      const s = this.buffer.toString('utf-8', this.offset, this.offset + size);
      // console.log('Read', size, 'bytes string', s);
      // console.log(this.buffer.toString('hex', this.offset, this.offset + size));
      this.offset += size;
      return s;
    }
  }

  readAdvanceByte(adv) {
    // console.log('Read advanced at pos', this.offset + adv);
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

function countMsgPerTalker(periodFn) {
  return _.flow(
    _.groupBy('user'),
    _.mapValues(_.flow(
      _.groupBy(msg => periodFn(msg.date)),
      _.mapValues('length'),
      _.toPairs,
    )),
    _.toPairs,
    _.filter(([name, data]) => data.length > 0),
  );
}

function print(obj) {
  console.log('-------------------');
  console.log(obj);
}

// ========== main ============

const db = new Database('/Users/leoliang/tmp/2018-04/wechat/decrypted.db', { readonly: true, fileMastExist: true });

const userMap = _.flow(
  _.keyBy('username'),
  _.mapValues('nickname')
)(db.prepare('SELECT username, nickname FROM rcontact').all());

const { roomdata } = db.prepare('SELECT roomdata FROM chatroom WHERE chatroomname=?').get(ROOM);
const nicknameMap = _.fromPairs(parseChatroomNicknames(roomdata));
const usernames = _.defaults(userMap, nicknameMap);

const messages = _.map(parseMsg)(
  db.prepare('SELECT content, createTime FROM message WHERE talker=? AND type IN (1,49) AND createTime<1524960000000 LIMIT 1000000').all(ROOM)
);

const period = (moment) => {
  return moment.month() * 3 + parseInt(moment.date() / 10);
};

const talkers = _.flow(
  _.mapValues(
    _.map(_.head),
  ),
  _.toPairs,
  _.map(_.tail),
  _.flattenDeep,
  _.uniq
)(topTalkers(3, period)(messages));

const out = _.flow(
  _.filter(msg => _.includes(msg.user, talkers)),
  countMsgPerTalker(period)
)(messages);

// print(out);
// console.log(JSON.stringify(out));

echarts({
  width: 800,
  height: 1000,
  path: './output/out.png',
  option: {
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
        type: 'line'
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
}).then(() => process.exit(0)).catch(console.log);
