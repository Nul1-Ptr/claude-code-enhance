var aq=600,oq=100,rq=(value)=>Math.max(300,600-value);
function BKe(messages,options){
  if(messages.length<=aq)return{messages,removedIndices:[]};
  let keep=Math.max(300,aq-oq);
  if(keep===messages.length)return{messages,removedIndices:[]};
  let removed=new Set;
  for(let index=0;index<messages.length-keep;index++)removed.add(index);
  return{messages:messages.filter((message,index)=>!removed.has(index)),removedIndices:[...removed]};
}
function zfe(messages,teleported){return BKe(messages,{teleportedCount:teleported}).messages}
function Hfe(messages,teleported,options){return BKe(messages,{...options,teleportedCount:teleported})}
const z=(initial)=>React.useState(initial),k=React.createElement,m=React.createElement,Xs=React.Fragment;
const Rg=[],gm=[],Wu=false,s={current:null};
function Conversation314({session:e}){
  let[opened,setOpened]=z(false),ke=void 0;
  return k("div",{ref:s,className:"messagesContainer_fixture",children:[
    Wu?Rg.map((turn,index)=>{return k(Xs,{children:[turn.banner,m("div",{className:"turn_fixture",children:[]})]},turn.key)}):
      gm.map((turn,index)=>{return k(Xs,{children:[turn.banner,m("div",{className:"turn_fixture",children:[]})]},turn.key)})
  ]});
}
const u=[],p={remarkPlugins:[],rehypePlugins:[]};
m(RH,{remarkPlugins:[...u,...p.remarkPlugins],rehypePlugins:p.rehypePlugins,urlTransform:U,components:{code:C,pre:P},children:text});
