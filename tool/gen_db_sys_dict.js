#!/usr/bin/env -S deno run -A --unstable-kv
// pmim-data-imewlconverter/tool/gen_db_sys_dict.js
// 生成 pmim_sys.db 数据库 (词库)
//
// 命令行示例:
// > deno run -A --unstable-kv gen_db_sys_dict.js pmim_sys.db imewlconverter/参考/8万精准超小词库.txt
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

import { batch_set, chunk_get } from "./kv_util.js";

// 将字符串按照 unicode code point 切分成单个字符
export function u切分(s) {
  const o = [];
  let i = 0;
  while (i < s.length) {
    const c = s.codePointAt(i);
    o.push(String.fromCodePoint(c));
    if (c > 0xffff) {
      i += 2;
    } else {
      i += 1;
    }
  }
  return o;
}

// 文件格式: imewlconverter/参考/8万精准超小词库.txt
async function 加载原始数据(文件) {
  console.log("读取 " + 文件);
  const 文本 = await Deno.readTextFile(文件);

  const 行 = 文本.split("\n");
  const 结果 = [];

  for (const i of 行) {
    const 内容 = i.trim();
    if (内容.length < 1) {
      // 忽略空白的行
      continue;
    }

    const 字符 = u切分(内容);
    // 分离 汉字 和 拼音 (a ~ z)
    const 汉字 = [];
    let 拼音 = [];

    let 临时拼音 = "";
    for (let j = 0; j < 字符.length; j += 1) {
      const c = 字符[j].codePointAt(0);
      if ((c >= "a".codePointAt(0)) && (c <= "z".codePointAt(0))) {
        // 拼音
        临时拼音 += 字符[j];
      } else {
        // 汉字
        汉字.push(字符[j]);

        拼音.push(临时拼音);
        临时拼音 = "";
      }
    }
    // 处理最后的临时拼音
    拼音.push(临时拼音);
    // 拼音标注在一个汉字的后面
    拼音 = 拼音.slice(1);

    结果.push([汉字, 拼音]);
  }
  return 结果;
}

class 拼音读取器 {
  constructor(kv) {
    this.kv = kv;
    this.cache = {};
  }

  async 初始化() {
    // 加载 preload/pinyin_tgh
    this.pt = await chunk_get(this.kv, ["data", "preload", "pinyin_tgh"]);
  }

  // 获取汉字对应的拼音
  async 拼音(c) {
    if (this.pt.cp[c] != null) {
      return this.pt.cp[c];
    }

    if (this.cache[c] != null) {
      return this.cache[c];
    }

    const { value } = await this.kv.get(["data", "pinyin", c]);
    if (value != null) {
      this.cache[c] = value;
      return value;
    }
    // 无法获取拼音
    return null;
  }
}

async function 处理(kv, 数据, p) {
  console.log("处理()  " + 数据.length);

  let 词数 = 0;

  const 写入 = [];
  // 收集所有前缀
  const pt = {};
  // 拼音至前缀
  const pp = {};
  for (const [词, 拼音] of 数据) {
    // 词至少是 2 个字
    if (词.length < 2) {
      continue;
    }
    // 前缀是词的前 2 个字
    const 前缀 = 词.slice(0, 2).join("");

    // 获取前缀的拼音
    let p0 = [], p1 = [];
    if (拼音[0].length > 0) {
      p0 = [拼音[0]];
    } else {
      p0 = await p.拼音(词[0]);
    }
    if (拼音[1].length > 0) {
      p1 = [拼音[1]];
    } else {
      p1 = await p.拼音(词[1]);
    }

    const 词1 = 词.join("");
    if ((null == p0) || (null == p1)) {
      console.log("忽略词 (无拼音): " + 词1);
      continue;
    }
    // 没有频率数据
    词数 += 1;
    // 收集前缀
    if (pt[前缀] != null) {
      pt[前缀].push(词1);
    } else {
      pt[前缀] = [词1];
    }

    // 生成拼音至前缀
    // TODO 正确处理 多音字 ?
    for (const i of p0) {
      for (const j of p1) {
        const pin_yin = i + "_" + j;
        if (pp[pin_yin] != null) {
          pp[pin_yin].push(前缀);
        } else {
          pp[pin_yin] = [前缀];
        }
      }
    }
  }
  // DEBUG
  console.log("  词数: " + 词数);
  console.log("  前缀 " + Object.keys(pt).length);
  console.log("  拼音 -> 前缀 " + Object.keys(pp).length);
  // 保存前缀
  for (const i of Object.keys(pt)) {
    写入.push([["data", "dict", i], pt[i]]);
  }
  // 保存拼音
  for (const i of Object.keys(pp)) {
    写入.push([["data", "dict", i], pp[i]]);
  }
  await batch_set(kv, 写入, 1000);

  // 元数据
  console.log("写入元数据");
  const PMIM_DB_VERSION = "pmim_sys_db version 0.1.0";
  const PMIM_VERSION = "pmim version 0.1.5";

  await kv.set(["pmim_db", "v"], {
    pmim: PMIM_VERSION,
    deno_version: Deno.version,
    n: "胖喵拼音内置数据库 (imewlconverter/8万精准超小词库.txt)",
    _last_update: new Date().toISOString(),
  });
  // 标记没有词的频率数据
  await kv.set(["pmim_db", "sys_dict_nc"], 1);
}

async function main() {
  const 输出 = Deno.args[0];
  console.log(`${输出}`);

  const 文件 = Deno.args[1];
  // 读取数据
  const 数据 = await 加载原始数据(文件);

  // 打开数据库
  const kv = await Deno.openKv(输出);

  const p = new 拼音读取器(kv);
  await p.初始化();
  await 处理(kv, 数据, p);

  // 记得关闭数据库
  kv.close();
}

if (import.meta.main) main();
