var bq=600,fq=100,mq=(value)=>Math.max(300,600-value);
function oGe(messages,options){
  if(messages.length<=bq)return{messages,removedIndices:[]};
  let keep=Math.max(300,bq-fq);
  if(keep===messages.length)return{messages,removedIndices:[]};
  let removed=new Set;
  for(let index=0;index<messages.length-keep;index++)removed.add(index);
  return{messages:messages.filter((message,index)=>!removed.has(index)),removedIndices:[...removed]};
}
function qfe(messages,teleported){return oGe(messages,{teleportedCount:teleported}).messages}
function Kfe(messages,teleported,options){return oGe(messages,{...options,teleportedCount:teleported})}
const B=(initial)=>React.useState(initial),k=React.createElement,m=React.createElement,ta=React.Fragment;
const Dg=[],bm=[],Ac=false,s={current:null};
function Conversation318({session:e}){
  let[opened,setOpened]=B(false),we=void 0;
  return k("div",{ref:s,className:"messagesContainer_fixture",children:[
    Ac?Dg.map((turn,index)=>{return k(ta,{children:[turn.banner,m("div",{className:"turn_fixture",children:[]})]},turn.key)}):
      bm.map((turn,index)=>{return k(ta,{children:[turn.banner,m("div",{className:"turn_fixture",children:[]})]},turn.key)})
  ]});
}
const u=[],p={remarkPlugins:[],rehypePlugins:[]};
m(NH,{remarkPlugins:[...u,...p.remarkPlugins],rehypePlugins:p.rehypePlugins,urlTransform:U,components:{code:C,pre:P},children:text});
