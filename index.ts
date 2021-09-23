export {}
import * as fs from 'fs'
import * as path from 'path'
import {promisify} from 'util'
import * as parser from 'node-html-parser'
import fetch from 'node-fetch'
import Queue from 'promise-queue'

const parse = (parser.default as any).default as typeof parser.default
const domCache = new Map<string, parser.HTMLElement>()
const readFile = promisify(fs.readFile)
const queue = process.argv.slice(2)
const fetchQueue = new Queue(5, Infinity)

let writeKnownErrors = false
if (queue[0] === "--write-known-errors") {
  writeKnownErrors = true
  queue.shift()
}

type Cache = Map<string, Promise<string>>
type Errors = Set<ErrorRec>
interface ErrorRec {
  partialPath: string,
  reference: string,
  referenceText: string,
  errorText: string,
}

loadCache()
  .then(loadErrors)
  .then(processQueue)
  .then(saveCache)
  .then(saveErrors)
  .then(exitWithCode)

function exitWithCode(errors: boolean) {
  if (errors) process.exit(1)
  else process.exit(0)
}

async function loadCache(): Promise<Cache> {
  try {
    const inn = JSON.parse(fs.readFileSync('.claa-cache', {encoding: 'utf8'}))
    return new Map(Object.entries(inn).map(([k,v]) => [k, Promise.resolve(v as string)]))
  } catch (e) {
    console.log('Failed to load cache')
    return new Map()
  }
}

async function loadErrors(cache: Cache): Promise<[Cache,Errors]> {
  try {
    const inn = JSON.parse(fs.readFileSync('.claa-known-errors', {encoding: 'utf8'}))
    return [cache, new Set(inn)]
  } catch (e) {
    console.log('Failed to load known errors')
    return [cache, new Set()]
  }
}

async function saveCache([hasErrors, errors, cache]: [boolean, Errors, Cache]): Promise<[boolean, Errors]> {
  const out = Object.fromEntries(await
    Promise.all(Array.from(cache.entries()).map(async ([k, v]) => [k, await v])))
  fs.writeFileSync('.claa-cache', JSON.stringify(out))
  return [hasErrors, errors]
}

async function saveErrors([hasErrors, errors]: [boolean, Errors]): Promise<boolean> {
  if(writeKnownErrors && hasErrors) {
    const out = Array.from(errors)
    fs.writeFileSync('.claa-known-errors', JSON.stringify(out,undefined,2))
  }
  return hasErrors
}

async function processQueue([cache, errors]: [Cache, Errors]): Promise<[boolean, Errors, Cache]> {
  if(queue.length === 0) return [false, errors, cache]
  let hasErrors = false
  const checks = new Set(Array.from(errors.values()).map(v => JSON.stringify(v)))
  while (queue.length > 0) {
    const url = queue.shift()
    const res = await checkLinks(cache, url!)
    for (const [p,h,t,r] of res) {
      if (r === true) continue
      const partialPath = path.join(path.basename(path.dirname(p)), path.basename(p))
      const errorText = 'code' in r ? (r as any)['code'] : r.toString()
      const error = {errorText, partialPath, reference: h, referenceText: t}
      if (checks.has(JSON.stringify(error))) continue
      console.log(`${partialPath} referencing ${t} (${h}) broken with ${r}\n`)
      if (writeKnownErrors) errors.add(error)
      hasErrors = true
    }
  }
  return [hasErrors, errors, cache]
}

async function checkLinks(cache: Cache, filepath: string): Promise<[string, string, string, true | object][]> {
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
      } else if (el.parentNode.innerText.startsWith('Defined in ')) {
        // do nothing
      } else if (el.innerText === 'Source') {
        // do nothing
      } else if (href.startsWith('#')) {
        await checkHrefAndAnchor(cache, dir, filepath, href.slice(1))
      } else {
        const [url, hash] = href.split('#')
        await checkHrefAndAnchor(cache, dir, url, hash)
      }
      return [filepath, href, el.innerText, true] as [string,string,string,true]
    } catch (e) {
      return [filepath, href, el.innerText, e] as [string,string,string,object]
    }
  }))
}

async function checkHrefAndAnchor(cache: Cache, dir: string, url: string, anchor: string) {
  const urlRaw = url.match(/^https?:\/\//) !== null
    ? url
    : getPath(dir, url)
  const contents = url.match(/^https?:\/\//) !== null
    ? await fetchWithCache(cache, url)
    : await readFile(getPath(dir, url), {encoding: 'utf8'})
  if (anchor && url.match(/^https?:\/\/gitlab.com\//) === null) {
    const dom = jsdomWithCache(url, contents)
    const elem = dom.querySelector(`#${escape(anchor)}`)
    if (elem === null) {
      const err: any = new Error(`Anchor ${anchor} not found in ${url}`)
      err.code = 'NOANCHOR'
      throw err
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

async function fetchWithCache(cache: Cache, url: string) {
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
