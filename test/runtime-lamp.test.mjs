import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
require("./vscode-stub.cjs");
const {SessionController}=require("../dist/controller.cjs");
const store=new Map();const state={get:(k,d)=>store.get(k)??d,update:(k,v)=>{store.set(k,v);return Promise.resolve()}};
const c=new SessionController({subscriptions:[],extensionUri:{fsPath:"/tmp"},workspaceState:state,globalState:state},{append(){},appendLine(){}});
c.scheduleHistoryRefresh=()=>{};c.scheduleChildrenRefresh=()=>{};c.onBusySettled=()=>{};
const file="/tmp/brief-roster-lamp.jsonl";
const summary={sessionId:"lamp",sessionFile:file,cwd:"/tmp",rlmDepth:0,activeSessionId:"active",rosterStatus:"running"};
c.attached={sessionId:"lamp",activeSessionId:"active",sessionPath:file};c.attachedEpoch=c.viewEpoch;
c.rentedState={sessionId:"lamp",sessionFile:file,isStreaming:true};c.streaming=true;
const posted=[];c.attach({post:m=>posted.push(m)});
try{
 c.rowsFromCatalog([summary]);
 const oldFetch=++c.historyRuntimeClock.revision;
 c.onAgentEvent({type:"agent_end",messages:[]});
 assert.equal(c.buildStatus().streaming,false,"agent_end clears stale attached snapshot isStreaming");
 c.onRosterUpdate({type:"roster_update",changed:[{agentId:"lamp",status:"idle",summary:{...summary,rosterStatus:"idle",isStreaming:false,hasRunningRlmChildren:false}}]});
 assert.equal(c.historyRuntime.get(file).status,"idle","idle roster push clears lamp immediately without history disk read");
 assert.equal(posted.filter(m=>m.type==="status").at(-1).status.historyRunning,false);
 c.rowsFromCatalog([summary],oldFetch);
 assert.equal(c.historyRuntime.get(file).status,"idle","slow old running catalog cannot overwrite newer idle push");
 c.onRosterUpdate({type:"roster_update",changed:[{agentId:"lamp",status:"running",summary}]});
 assert.equal(c.historyRuntime.get(file).status,"running","later actual work still turns lamp red");
 c.onRosterUpdate({type:"roster_update",changed:[{agentId:"lamp",status:"idle",summary:{...summary,hasRunningRlmChildren:true}}]});
 assert.equal(c.historyRuntime.get(file).status,"running","real delegated work remains running");
 console.log("runtime lamp refresh tests passed");
}finally{c.dispose()}
