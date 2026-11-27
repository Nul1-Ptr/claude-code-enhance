const mathAsset = new URL('math.js', import.meta.url);
const loadMathAsset = () => import(mathAsset.href);
var retentionCap=600,retentionReserve=100;
function kj(messages,options){
  if(messages.length<=retentionCap)return{messages,removedIndices:[]};
  let keep=Math.max(300,retentionCap-retentionReserve);
  if(keep===messages.length)return{messages,removedIndices:[]};
  let removed=new Set;
  for(let index=0;index<messages.length-keep;index++)removed.add(index);
  return{messages:messages.filter((message,index)=>!removed.has(index)),removedIndices:[...removed]};
}
function UA(messages,teleported){return kj(messages,{teleportedCount:teleported}).messages}
function WA(messages,teleported,options){return kj(messages,{...options,teleportedCount:teleported})}
const useState=(initial)=>React.useState(initial),fragmentElement=React.createElement,turnElement=React.createElement,Fragment=React.Fragment;
const primaryTurns=[],secondaryTurns=[],usePrimary=false,listRef={current:null};
function Conversation332({session}){
  let[opened,setOpened]=useState(false);
  return fragmentElement('div',{ref:listRef,className:'messagesContainer_fixture',children:[
    usePrimary?primaryTurns.map((turn,index)=>{return fragmentElement(Fragment,{children:[turn.banner,turnElement('div',{className:'turn_fixture',children:[]})]},turn.key)}):
      secondaryTurns.map((turn,index)=>{return fragmentElement(Fragment,{children:[turn.banner,turnElement('div',{className:'turn_fixture',children:[]})]},turn.key)})
  ]});
}
function MathMarkdown({source,isMathEnabled,mathCosts,index,drawsMath,isCodeColored}){
  const plugins=useMath(source,isMathEnabled,mathCosts,index,drawsMath);
  const components=memo(()=>({code:codeRenderer(isCodeColored),pre:Pre}),[isCodeColored]);
  return turnElement(Markdown,{remarkPlugins:[...basePlugins,...plugins.remarkPlugins],rehypePlugins:plugins.rehypePlugins,components,children:source});
}
export { MathMarkdown, Conversation332, loadMathAsset };
