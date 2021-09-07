export {}
import * as fs from 'fs'
import * as path from 'path'
import {promisify} from 'util'
import * as parser from 'node-html-parser'
import fetch from 'node-fetch'
import Queue from 'promise-queue'

const parse = (parser.default as any).default as typeof parser.default

let cache = new Map<string, Promise<string>>()
const domCache = new Map<string, parser.HTMLElement>()

const readFile = promisify(fs.readFile)

const queue = process.argv.slice(2)

const fetchQueue = new Queue(5, Infinity)

let hasErrors = false

loadCache()
  .then(processQueue)
  .then(saveCache)
  .then(exitWithCode)

function exitWithCode() {
  if (hasErrors) process.exit(1)
  else process.exit(0)
}

async function loadCache() {
  try {
    const inn = JSON.parse(fs.readFileSync('.claa-cache', {encoding: 'utf8'}))
    cache = new Map(Object.entries(inn).map(([k,v]) => [k, Promise.resolve(v as string)]))
  } catch (e) {
    console.log('Failed to load cache')
  }
}

async function saveCache() {
  const out = Object.fromEntries(await
    Promise.all(Array.from(cache.entries()).map(async ([k, v]) => [k, await v])))
  fs.writeFileSync('.claa-cache', JSON.stringify(out))
}

async function processQueue(): Promise<void> {
  if(queue.length === 0) return
  while (queue.length > 0) {
    const url = queue.shift()
    const res = await checkLinks(url!)
    for (const [p,h,t,r] of res) {
      if (r === true) continue
      console.log(`${path.basename(p)} referencing ${t} (${h}) broken with ${r}\n`)
      hasErrors = true
    }
  }
}

async function checkLinks(filepath: string): Promise<[string, string, string, true | object][]> {
  const fileContent = await readFile(filepath, {encoding: 'utf8'})
  const dom = jsdomWithCache(filepath, fileContent)
  const dir = path.dirname(filepath)
  return Promise.all(dom.querySelectorAll('a[href]').map(async (el: parser.HTMLElement) => {
    const href = el.getAttribute('href')
    let parent = el
    while(parent) {
      if(parent.classList.contains('src')) {
        return [filepath, href, el.innerText, true] as [string,string,string,true]
      }
      parent = parent.parentNode
    }
    try {
      if (!href) {
        // do nothing
      } else if (href.match(/#line-[0-9]+$/) !== null) {
        // do nothing
      } else if (href.startsWith('about:')) {
        // do nothing
      } else if (el.innerText === 'Source') {
        // do nothing
      } else if (href.startsWith('#')) {
        await checkHrefAndAnchor(dir, filepath, href.slice(1))
      } else {
        const [url, hash] = href.split('#')
        await checkHrefAndAnchor(dir, url, hash)
      }
      return [filepath, href, el.innerText, true] as [string,string,string,true]
    } catch (e) {
      return [filepath, href, el.innerText, e] as [string,string,string,object]
    }
  }))
}

async function checkHrefAndAnchor(dir: string, url: string, anchor: string) {
  const urlRaw = url.match(/^https?:\/\//) !== null
    ? url
    : getPath(dir, url)
  const contents = url.match(/^https?:\/\//) !== null
    ? await fetchWithCache(url)
    : await readFile(getPath(dir, url), {encoding: 'utf8'})
  if (anchor) {
    const dom = jsdomWithCache(url, contents)
    const elem = dom.querySelector(`#${escape(anchor)}`)
    if (elem === null) {
      throw new Error(`Anchor ${anchor} not found in ${url}`)
    }
  }
  // console.log(url, anchor, 'OK')
}

function escape(str: string) {
  return str.replace(/[:.# ]/g, s => `\\${s}`)
}

function getPath(dir: string, url: string) {
  if (url.startsWith('file://')) {
    url = url.slice(7)
  }
  if (path.isAbsolute(url)) return url
  else return path.join(dir, url)
}

async function fetchWithCache(url: string) {
  let res = cache.get(url)
  if (res!==undefined) return res
  res = fetchQueue.add(async () => (await fetch(url)).text())
  cache.set(url, res)
  return res
}

function jsdomWithCache(url: string, contents: string) {
  let res = domCache.get(url)
  if (res!==undefined) return res
  res = parse(contents)
  domCache.set(url, res)
  return res
}
