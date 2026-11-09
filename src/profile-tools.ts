/** Register these definitions with the conversational agent, NOT the news judge.
 * The caller executes returned calls via the authenticated per-user tools endpoint.
 */
const bounded = (maxLength:number) => ({type:'string',minLength:1,maxLength});
const identifier = {type:'string',minLength:1,maxLength:64,pattern:'^[a-zA-Z0-9_-]+$'};
const mode = {type:'string',enum:['prefer','less','exclude','digest']};
const operation = (name:string, properties:Record<string,unknown>, required=Object.keys(properties)) => ({type:'object',properties:{op:{const:name},...properties},required:['op',...required],additionalProperties:false});
const settings = {type:'object',additionalProperties:false,minProperties:1,properties:{name:bounded(80),minScore:{type:'integer',minimum:0,maximum:100},minConfidence:{type:'number',minimum:0,maximum:1},dailyLimit:{type:'integer',minimum:0,maximum:20},timezone:bounded(100),quietStart:{type:'integer',minimum:0,maximum:23},quietEnd:{type:'integer',minimum:0,maximum:23},enabled:{type:'boolean'},cooldownMinutes:{type:'integer',minimum:0,maximum:10080}}};
const metadata = {expectedRevision:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER-1},changeId:identifier,reason:bounded(500),evidence:bounded(1000)};
const functionTool=(name:string,description:string,properties:Record<string,unknown>={},required=Object.keys(properties))=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const PROFILE_TOOLS = [
 functionTool('get_profile','Read the current user profile and revision before proposing changes. Explicit preferences outrank inferred hints.'),
 functionTool('update_profile','Apply user-authorized structured changes. Preserve exact feedback in evidence. No reply is not negative feedback. One disliked article is not authority to exclude a whole topic. Inferences are only weak hints. Use a stable unique changeId for retries; on conflict read again, do not blindly retry.',{...metadata,operations:{type:'array',minItems:1,maxItems:20,items:{oneOf:[
  operation('set_topic',{topic:bounded(300),mode}),operation('remove_topic',{topic:bounded(300)}),
  operation('set_source',{sourceId:identifier,mode}),operation('remove_source',{sourceId:identifier}),
  operation('set_inferred_topic',{topic:bounded(300),weight:{type:'number',minimum:-0.25,maximum:0.25},evidence:bounded(500)}),operation('remove_inferred_topic',{topic:bounded(300)}),
  operation('set_delivery',{delivery:{type:'string',enum:['alert','digest','paused']}}),operation('set_settings',{settings}),
  operation('set_interests',{interests:{type:'array',minItems:1,maxItems:20,items:bounded(300)},excludedTopics:{type:'array',maxItems:20,items:bounded(300)}})
 ]}}}),
 functionTool('list_profile_changes','Read the latest changes and explanations for this user. Older history is retained in the database.'),
 functionTool('undo_profile_change','Undo only the latest profile change without overwriting later edits. Creates a new audited revision; does not resend news.',{...metadata,targetChangeId:identifier}),
 functionTool('preview_collection_plan','Show the proposed polling intervals for administrator-approved sources. Cannot add arbitrary URLs or spend money.'),
] as const;
export function parseToolCall(value:unknown):{name:string;arguments:Record<string,unknown>} {
 if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid_tool_call');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['name','arguments'].includes(k)) || typeof v.name!=='string' || !PROFILE_TOOLS.some(t=>t.function.name===v.name) || !v.arguments || typeof v.arguments!=='object' || Array.isArray(v.arguments)) throw new Error('invalid_tool_call');
 if(['get_profile','list_profile_changes','preview_collection_plan'].includes(v.name) && Object.keys(v.arguments).length) throw new Error('invalid_tool_arguments');
 return {name:v.name,arguments:v.arguments as Record<string,unknown>};
}
