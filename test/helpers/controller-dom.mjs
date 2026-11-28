// Small event/DOM fixture for exercising shipped controllers without a browser.
export function element(tag='div',text='',className='') {
 const node={tag,ownText:text??'',className,dataset:{},children:[],listeners:{},hidden:false,disabled:false,open:false,checked:false,value:'',isConnected:true,
  append(...children){for(const child of children){child.parentNode=this;this.children.push(child)}},
  replaceChildren(...children){this.children=[];this.append(...children)},
  insertBefore(child,before){const index=this.children.indexOf(before);child.parentNode=this;this.children.splice(index<0?this.children.length:index,0,child)},
  replaceWith(node){if(this.parentNode){const parent=this.parentNode;parent.children[parent.children.indexOf(this)]=node;node.parentNode=parent;}},
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.isConnected=false},
  addEventListener(event,listener){(this.listeners[event]??=[]).push(listener)},
  async emit(event){for(const listener of this.listeners[event]??[])await listener({currentTarget:this,preventDefault(){}})},
  click(){if(!this.disabled)return this.emit('click')},
  showModal(){this.open=true},close(){this.open=false;void this.emit('close')},
  setAttribute(name,value){this[name]=String(value)},focus(){},
  querySelector(selector){return this.querySelectorAll(selector)[0]??null},
  querySelectorAll(selector){return descendants(this).filter(child=>matches(child,selector))},
 };
 Object.defineProperty(node,'lastElementChild',{get:()=>node.children.at(-1)});
 Object.defineProperty(node,'textContent',{get:()=>[node.ownText,...node.children.map(c=>c.textContent)].join(' '),set:value=>{node.ownText=value;node.children=[]}});
 node.classList={contains:name=>node.className.split(' ').includes(name),add(...names){node.className=[...new Set([...node.className.split(' '),...names])].join(' ')},remove(...names){node.className=node.className.split(' ').filter(n=>!names.includes(n)).join(' ')},toggle(name,force){const add=force??!this.contains(name);add?this.add(name):this.remove(name);return add}};
 return node;
}
export function descendants(node){return node.children.flatMap(child=>[child,...descendants(child)])}
function matches(node,selector){
 const tag=selector.match(/^[a-z]+/)?.[0];if(tag&&tag!==node.tag)return false;
 for(const match of selector.matchAll(/\.([a-z-]+)/g))if(!node.classList.contains(match[1]))return false;
 for(const match of selector.matchAll(/\[data-([a-z-]+)(?:=["']?([^"'\]]+)["']?)?\]/g)){
  const key=match[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());if(!(key in node.dataset)||match[2]!==undefined&&String(node.dataset[key])!==match[2])return false;
 }
 return true;
}
