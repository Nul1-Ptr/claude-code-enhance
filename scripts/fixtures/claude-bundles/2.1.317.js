var mq=600,hq=100,pq=(value)=>Math.max(300,600-value);
function tGe(messages,options){
  if(messages.length<=mq)return{messages,removedIndices:[]};
  let keep=Math.max(300,mq-hq);
  if(keep===messages.length)return{messages,removedIndices:[]};
  let removed=new Set;
  for(let index=0;index<messages.length-keep;index++)removed.add(index);
  return{messages:messages.filter((message,index)=>!removed.has(index)),removedIndices:[...removed]};
}
function $fe(messages,teleported){return tGe(messages,{teleportedCount:teleported}).messages}
function jfe(messages,teleported,options){return tGe(messages,{...options,teleportedCount:teleported})}
const B=(initial)=>React.useState(initial),k=React.createElement,m=React.createElement,na=React.Fragment;
const _m=[],qb=[],ec=false,s={current:null};
function Conversation317({session:e}){
  let[opened,setOpened]=B(false),Ce=void 0;
  return k("div",{ref:s,className:"messagesContainer_fixture",children:[
    ec?_m.map((turn,index)=>{return k(na,{children:[turn.banner,m("div",{className:"turn_fixture",children:[]})]},turn.key)}):
      qb.map((turn,index)=>{return k(na,{children:[turn.banner,m("div",{className:"turn_fixture",children:[]})]},turn.key)})
  ]});
}
const u=[],p={remarkPlugins:[],rehypePlugins:[]};
m(DH,{remarkPlugins:[...u,...p.remarkPlugins],rehypePlugins:p.rehypePlugins,urlTransform:U,components:{code:C,pre:P},children:text});
