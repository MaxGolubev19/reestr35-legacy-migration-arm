<?php
// Memory-only integration harness: no Bitrix bootstrap, database or filesystem writes.
namespace Bitrix\Main {
    class Application { public static function getConnection() { return $GLOBALS['db']; } }
    class Loader { public static function includeModule($name) { return true; } }
}
namespace {
class Reply extends \Exception { public $value; public function __construct($value) { $this->value = $value; } }
class Rows {
    private $rows; public function __construct($rows) { $this->rows = array_values($rows); }
    public function fetch() { return array_shift($this->rows); }
    public function GetNextElement() { $row = $this->fetch(); return $row ? new Element($row) : false; }
}
class Element {
    private $row; public function __construct($row) { $this->row = $row; }
    public function GetFields() { return $this->row; }
    public function GetProperties() {
        $out = []; foreach ($this->row['PROPERTY_VALUES'] as $key => $value) {
            $out[$key] = ['~VALUE' => isset($value['VALUE']) ? $value['VALUE'] : $value];
        } return $out;
    }
}
class CIBlockElement {
    public static function GetList($sort, $filter, $group = false, $nav = false, $select = []) {
        $rows = array_filter($GLOBALS['db']->items, function ($row) use ($filter) {
            foreach ($filter as $key => $value) {
                if ($key === 'CHECK_PERMISSIONS') { continue; }
                if (strpos((string)$key, '=PROPERTY_') === 0) {
                    $propertyKey = strtolower(substr($key, 10));
                    if (ctype_digit($propertyKey)) {
                        foreach (CIBlockProperty::rows() as $property) {
                            if ((string)$property['ID'] === $propertyKey) { $propertyKey = $property['CODE']; break; }
                        }
                    }
                    if ((string)($row['PROPERTY_VALUES'][$propertyKey] ?? '') !== (string)$value) { return false; }
                } elseif ($key === 'ID' || $key === 'IBLOCK_ID') { if ($row[$key] != $value) { return false; } }
            } return true;
        });
        usort($rows, function ($a, $b) { return $a['ID'] <=> $b['ID']; });
        return new Rows($rows);
    }
    public function Add($fields) {
        $id = ++$GLOBALS['db']->lastId; $fields['ID'] = $id;
        $GLOBALS['db']->items[$id] = $fields; $GLOBALS['db']->writes[] = ['add', $id]; return $id;
    }
    public function Update($id, $fields, $workflow = false, $resize = false) {
        if ($GLOBALS['db']->failUpdate === $id) { return false; }
        $GLOBALS['db']->items[$id] = array_replace($GLOBALS['db']->items[$id], $fields);
        $GLOBALS['db']->writes[] = ['update', $id]; return true;
    }
    public static function Delete($id) {
        unset($GLOBALS['db']->items[$id]); $GLOBALS['db']->writes[] = ['delete', $id]; return true;
    }
    public static function SetPropertyValuesEx($id, $iblock, $props) {
        $GLOBALS['db']->items[$id]['PROPERTY_VALUES'] = array_replace($GLOBALS['db']->items[$id]['PROPERTY_VALUES'], $props);
        $GLOBALS['db']->writes[] = ['properties', $id];
    }
    public static function GetProperty($iblock, $id, $sort, $filter) {
        foreach (CIBlockProperty::rows() as $property) {
            if ($property['ID'] === $filter['ID'] && $property['IBLOCK_ID'] === $iblock) {
                $value = $GLOBALS['db']->items[$id]['PROPERTY_VALUES'][$property['CODE']] ?? null;
                return new Rows(array_map(function($v) { return ['VALUE'=>$v]; }, is_array($value) ? $value : [$value]));
            }
        }
        return new Rows([]);
    }
}
class CIBlockProperty {
    public static function rows() {
        $schema = [14 => ['company'=>'E','parent'=>'E'],15=>['company'=>'E','tab'=>'E','type'=>'N'],
            16=>['company'=>'E','block'=>'E','parent'=>'S','title'=>'S','text'=>'S','link'=>'S','show_border'=>'S','image'=>'E','left_image'=>'E','right_image'=>'E','view'=>'S','meta'=>'S'],
            17=>['company'=>'E','original'=>'F','big'=>'F','href'=>'S','alt'=>'S','caption'=>'S']];
        $rows=[]; $id=60; foreach ($schema as $iblock=>$props) { foreach ($props as $code=>$type) {
            $rows[]=['ID'=>++$id,'IBLOCK_ID'=>$iblock,'CODE'=>$code,'PROPERTY_TYPE'=>$type,'MULTIPLE'=>'N','USER_TYPE'=>$code==='text'?'HTML':''];
        }} return array_merge($rows,$GLOBALS['db']->extraProperties);
    }
    public static function GetList($sort, $filter) {
        return new Rows(array_filter(self::rows(), function($property) use ($filter) {
            foreach($filter as $key=>$value) { if(($property[$key]??null)!==$value) {return false;} } return true;
        }));
    }
}
class Db {
    public $items = [], $options = [], $writes = [], $lastId = 1000, $failUpdate = 0, $commitFailure = null, $engine = 'InnoDB';
    public $extraProperties = [];
    private $backup;
    public function getSqlHelper() { return $this; }
    public function forSql($value) { return addslashes($value); }
    public function query($sql) {
        if (preg_match('/SELECT ID FROM b_iblock_element WHERE WF_PARENT_ELEMENT_ID=(\d+)/', $sql, $m)) {
            return new Rows(array_filter($this->items, function($row) use ($m) { return (int)($row['WF_PARENT_ELEMENT_ID']??0)===(int)$m[1]; }));
        }
        if (strpos($sql, 'GET_LOCK') !== false) { return new Rows([['acquired'=>1]]); }
        if (strpos($sql, 'RELEASE_LOCK') !== false || strpos($sql, 'FOR UPDATE') !== false) { return new Rows([]); }
        if (strpos($sql, 'information_schema') !== false) {
            return new Rows(array_map(function($name) { return ['TABLE_NAME'=>$name,'ENGINE'=>$this->engine]; },
                ['b_option','b_file','b_iblock_element','b_iblock_element_property']));
        }
        if (preg_match("/SELECT (VALUE|NAME) FROM b_option .* NAME='((?:\\\\.|[^'])*)'/", $sql, $m)) {
            $key = stripslashes($m[2]); return new Rows(isset($this->options[$key]) ? [[$m[1]=>$m[1]==='VALUE'?$this->options[$key]:$key]] : []);
        }
        throw new \Exception('Unexpected query: ' . $sql);
    }
    public function queryExecute($sql) {
        if (strpos($sql, 'SET ') === 0) { return; }
        if (preg_match("/INSERT INTO b_option .* VALUES \\('reestr35.arm','((?:\\\\.|[^'])*)','((?:\\\\.|[^'])*)'/", $sql, $m)) {
            $this->options[stripslashes($m[1])] = stripslashes($m[2]); return;
        }
        if (preg_match("/UPDATE b_option SET VALUE='((?:\\\\.|[^'])*)'.* NAME='((?:\\\\.|[^'])*)'/", $sql, $m)) {
            $this->options[stripslashes($m[2])] = stripslashes($m[1]); return;
        }
        if (preg_match("/DELETE FROM b_option .* NAME='((?:\\\\.|[^'])*)'/", $sql, $m)) {
            $key=stripslashes($m[1]); foreach(array_keys($this->options) as $name) {
                if($name===$key || strpos($name,$key.'.')===0) { unset($this->options[$name]); }
            } return;
        }
        throw new \Exception('Unexpected execute: ' . $sql);
    }
    public function startTransaction() { $this->backup = [$this->items, $this->options]; }
    public function rollbackTransaction() { if ($this->backup) { list($this->items, $this->options) = $this->backup; $this->backup=null; } }
    public function commitTransaction() {
        $failure=$this->commitFailure; $this->commitFailure=null;
        if ($failure==='before') { throw new \Exception('commit connection lost before send'); }
        $this->backup=null;
        if ($failure==='after') { throw new \Exception('commit acknowledgement lost'); }
    }
}
function check($condition, $label) { if (!$condition) { throw new \Exception('ASSERTION: '.$label); } }
function replaceFunction($source, $name, $replacement) {
    $start = strpos($source, 'function '.$name.'('); check($start !== false, 'function '.$name.' exists');
    $next = strpos($source, "\nfunction ", $start+1); check($next !== false, 'function boundary');
    return substr($source,0,$start).$replacement."\n".substr($source,$next);
}
$source = base64_decode('__ARM_SOURCE_B64__');
check(strpos($source, "if (PHP_SAPI !== 'cli') { arm_fail('ssh_only', 403); }") !== false, 'public HTTP hard gate remains');
$boundary = strpos($source, '$lock = null;'); check($boundary!==false, 'main boundary');
$functions=substr($source,5,$boundary-5); $main=substr($source,$boundary);
$functions=replaceFunction($functions,'arm_reply', 'function arm_reply($value, $status = 200) { throw new Reply($value); }');
$functions=replaceFunction($functions,'arm_initialize_cli', 'function arm_initialize_cli() {}');
eval($functions);
$main=str_replace("file_get_contents('php://stdin', false, null, 0, 64 * 1024 * 1024 + 1)", 'arm_json($request)', $main);
$main=str_replace("require \$_SERVER['DOCUMENT_ROOT'] . '/bitrix/modules/main/include/prolog_before.php';", '', $main);
$main=str_replace("} catch (Throwable \$error) {", "} catch (Throwable \$error) { if (\$error instanceof Reply) { throw \$error; }", $main);
function request($request) {
    global $main, $armPreparedFiles, $armSavedFiles;
    try { eval($main); } catch (Reply $reply) { return $reply->value; }
    throw new \Exception('missing response');
}
$db=new Db();
foreach([1,2] as $company) { $db->items[$company]=['ID'=>$company,'IBLOCK_ID'=>12,'NAME'=>'Test company','ACTIVE'=>'Y','SORT'=>500,'PROPERTY_VALUES'=>['old_id'=>(string)$company]]; }
$base=['company_id'=>1,'scope_id'=>'test-scope','epoch'=>1];
function state() { global $base; return request($base+['action'=>'state']); }
function operation($object, $operationId=null, $override=[]) {
    global $base; $s=state();
    return array_replace($base+['action'=>'apply_object','operation_id'=>$operationId??uniqid('op'),
        'base_revision'=>$s['revision'],'base_fingerprint'=>$s['fingerprint'],'object'=>$object],$override);
}
function tab($key, $action='create', $id=null) {
    $o=['kind'=>'tab','action'=>$action,'local_id'=>$key,'value'=>['local_id'=>$key,'name'=>$key,'sort'=>500,'parent_local_id'=>null]];
    if($id!==null) {$o['id']=$id;} return $o;
}
function block($key,$tabKey=null,$tabId=null,$action='create',$id=null,$previousTab=null,$text='original') {
    $o=['kind'=>'block','action'=>$action,'local_id'=>$key,'tab_id'=>$tabId,'previous_tab_id'=>$previousTab,'media'=>[],'files'=>[],
        'value'=>['local_id'=>$key,'tab_local_id'=>$tabKey,'name'=>$key,'sort'=>500,'type'=>1,
        'content'=>[['local_id'=>'root','sort'=>500,'parent_local_id'=>null,'properties'=>['text'=>$text]]]]];
    if($id!==null){$o['id']=$id;}return $o;
}
function ok($result,$label){check(($result['ok']??false)===true,$label.': '.json_encode($result));return $result;}
function error($result,$code){check(($result['error']['code']??null)===$code,'expected '.$code.': '.json_encode($result));}
$a=ok(request(operation(tab('a'))),'create tab A')['object']['id'];
$b=ok(request(operation(tab('b'))),'create tab B')['object']['id'];
$control=ok(request(operation(block('control'))),'create unchanged control')['object']['id'];
$controlBefore=$db->items[$control]; $controlContent=state()['bindings']['content']['control']['root']; $controlTextBefore=$db->items[$controlContent];
$createRequest=operation(block('target','a',$a),'stable-create');
$created=ok(request($createRequest),'create target'); $id=$created['object']['id'];
$writes=count($db->writes);check(request($createRequest)===$created,'idempotent duplicate receipt');check(count($db->writes)===$writes,'duplicate creates no writes');
$changed=$createRequest;$changed['object']['value']['name']='different';error(request($changed),'operation_payload_conflict');
$status=ok(request($base+['action'=>'operation_status','operation_id'=>'stable-create']),'status'); check($status['state']==='applied'&&$status['result']===$created,'uncertain response reconciles same ID');
$updated=ok(request(operation(block('target','a',$a,'update',$id,$a,'edited'))),'update target');
check($updated['object']['id']===$id,'update keeps Bitrix ID');
$tabUpdate=tab('a','update',$a);$tabUpdate['value']['name']='renamed';$targetBefore=$db->items[$id];
ok(request(operation($tabUpdate)),'rename tab');check($db->items[$id]===$targetBefore,'tab rename does not rewrite blocks');
$tabMove=tab('a','move',$a);$tabMove['value']['name']='renamed';$tabMove['value']['sort']=750;
ok(request(operation($tabMove)),'move tab');check($db->items[$id]===$targetBefore,'tab reorder does not rewrite blocks');
$forged=block('target','a',$a,'update',$control,$a);error(request(operation($forged)),'binding_conflict');
error(request(operation(block('target','a',$a,'update',$id,$a),null,['scope_id'=>'foreign-scope'])),'company_scope_conflict');
error(request(operation(block('target','a',$a,'update',$id,$a),null,['base_revision'=>0])),'revision_conflict');
$externalBefore=$db->items[$id];$db->items[$id]['NAME']='external edit';
error(request(operation(block('target','a',$a,'update',$id,$a))),'external_change_conflict');
check($db->items[$id]['NAME']==='external edit','external change not overwritten');$db->items[$id]=$externalBefore;
$writes=count($db->writes);$before=$db->items;
error(request(operation(block('target','b',$b,'update',$id,$b,'bad source'))),'tab_binding_conflict');check($db->items===$before,'wrong source no-op');
$foreign=(new CIBlockElement())->Add(['IBLOCK_ID'=>14,'NAME'=>'foreign','ACTIVE'=>'Y','SORT'=>500,'PROPERTY_VALUES'=>['company'=>2,'parent'=>0]]);
$s=state(); // Foreign company changes are outside this fingerprint.
error(request(operation(block('target','foreign',$foreign,'update',$id,$a))),'ownership_conflict');check($db->items[$id]['PROPERTY_VALUES']['tab']===$a,'foreign target rejected');
$move=['kind'=>'block','action'=>'move','local_id'=>'target','id'=>$id,'tab_id'=>$b,'previous_tab_id'=>$a,
    'value'=>['local_id'=>'target','tab_local_id'=>'b','sort'=>600]];
$contentBefore=$db->items[state()['bindings']['content']['target']['root']];
ok(request(operation($move)),'move');check($db->items[state()['bindings']['content']['target']['root']]===$contentBefore,'move does not rewrite content');
check(state()['block_tabs']['target']===$b,'state confirms parent');
error(request(operation(tab('b','delete',$b))),'unmanaged_dependents_conflict');
$update=block('target','b',$b,'update',$id,$b,'will rollback');$before=$db->items;$revision=state()['revision'];
$db->failUpdate=state()['bindings']['content']['target']['root'];error(request(operation($update,'rollback')),'bitrix_write_failed');$db->failUpdate=0;
check($db->items===$before&&state()['revision']===$revision,'failed content update rolls back block and journal state');
$db->engine='MyISAM';error(request(operation($update)),'transactional_storage_required');$db->engine='InnoDB';check($db->items===$before,'nontransactional storage fails closed');
$db->commitFailure='after';$uncertain=operation($update,'commit-after');error(request($uncertain),'internal_error');
$status=ok(request($base+['action'=>'operation_status','operation_id'=>'commit-after']),'commit readback');check($status['state']==='applied','lost commit ack preserves applied receipt');
$update['value']['content'][0]['properties']['text']='not committed';$db->commitFailure='before';
error(request(operation($update,'commit-before')),'internal_error');
$status=ok(request($base+['action'=>'operation_status','operation_id'=>'commit-before']),'rollback readback');check($status['state']==='failed'&&$status['result']['error']['code']==='operation_not_applied','uncommitted uncertain operation reconciles');
$s=state();$stuckKey='op.'.substr(hash('sha256','1:test-scope:legacy-stuck'),0,40);
arm_option_set($stuckKey,['state'=>'in_progress','base_revision'=>$s['revision']-1,'base_fingerprint'=>$s['fingerprint']]);
check(request($base+['action'=>'operation_status','operation_id'=>'legacy-stuck'])['state']==='requires_reconciliation','ambiguous legacy inFlight never guessed or reapplied');
check(request($base+['action'=>'operation_status','operation_id'=>'never-sent'])['state']==='not_found','unknown operation status');
$s=state();error(request($base+['action'=>'apply','operation_id'=>'legacy-new','base_revision'=>$s['revision'],'base_fingerprint'=>$s['fingerprint'],'snapshot'=>[]]),'snapshot_protocol_retired');
$legacy=$base+['action'=>'apply','operation_id'=>'legacy-applied','base_revision'=>0,'base_fingerprint'=>str_repeat('0',64),'snapshot'=>[]];
$legacyResult=['ok'=>true,'operation_id'=>'legacy-applied','revision'=>1,'bindings'=>[]];
$legacyKey='op.'.substr(hash('sha256','1:test-scope:legacy-applied'),0,40);
arm_option_set($legacyKey,['state'=>'applied','digest'=>hash('sha256',arm_json($legacy)),'result'=>$legacyResult]);
check(request($legacy)===$legacyResult,'legacy applied retry only returns original receipt');
check(request($base+['action'=>'operation_status','operation_id'=>'legacy-applied'])['result']===$legacyResult,'legacy inFlight status compatible');
$deleteTarget=['kind'=>'block','action'=>'delete','local_id'=>'target','id'=>$id,'previous_tab_id'=>$b];
// These fields are deliberately absent from the legacy fingerprint: the new
// guard must detect them directly and preserve the content already deleted in
// this transaction when it rolls back at the block-level check.
foreach(['PREVIEW_PICTURE','DETAIL_PICTURE'] as $picture) {
    $db->items[$id][$picture]=901;$before=$db->items;
    error(request(operation($deleteTarget)),'delete_files_conflict');check($db->items===$before,'picture guard rolls back children and preserves file');
    unset($db->items[$id][$picture]);
}
$db->extraProperties=[['ID'=>800,'IBLOCK_ID'=>15,'CODE'=>'attachment','PROPERTY_TYPE'=>'F','MULTIPLE'=>'Y','USER_TYPE'=>'','ACTIVE'=>'N']];
$db->items[$id]['PROPERTY_VALUES']['attachment']=[901,902];
// Synchronize only this fixture fingerprint, representing legacy data that
// already had the extra property before the client observed state.
$stored=arm_option_get('company.1');$stored['fingerprint']=arm_fingerprint(1);arm_option_set('company.1',$stored);
$before=$db->items;error(request(operation($deleteTarget)),'delete_files_conflict');check($db->items===$before,'inactive multiple F guard preserves files and content');
unset($db->items[$id]['PROPERTY_VALUES']['attachment']);$db->extraProperties=[];
$stored=arm_option_get('company.1');$stored['fingerprint']=arm_fingerprint(1);arm_option_set('company.1',$stored);
$db->extraProperties=[['ID'=>801,'IBLOCK_ID'=>99,'CODE'=>'foreign_link','PROPERTY_TYPE'=>'E','MULTIPLE'=>'N','USER_TYPE'=>'','ACTIVE'=>'N']];
$ref=(new CIBlockElement())->Add(['IBLOCK_ID'=>99,'NAME'=>'inactive foreign backlink','ACTIVE'=>'N','SORT'=>500,'PROPERTY_VALUES'=>['foreign_link'=>$id]]);
$before=$db->items;error(request(operation($deleteTarget)),'external_element_reference_conflict');
check($db->items===$before,'inactive global E backlink preserved without child deletion');
unset($db->items[$ref]);$db->extraProperties=[];
$copy=(new CIBlockElement())->Add(['IBLOCK_ID'=>99,'NAME'=>'workflow copy','ACTIVE'=>'N','SORT'=>500,'WF_PARENT_ELEMENT_ID'=>$id,'PREVIEW_PICTURE'=>901,'PROPERTY_VALUES'=>[]]);
$before=$db->items;error(request(operation($deleteTarget)),'workflow_dependents_conflict');check($db->items===$before,'workflow copies and their pictures preserved');unset($db->items[$copy]);
ok(request(operation(['kind'=>'block','action'=>'delete','local_id'=>'target','id'=>$id,'previous_tab_id'=>$b])),'delete block');
check(!isset($db->items[$id])&&!isset(state()['bindings']['blocks']['target']),'block and binding deleted');
ok(request(operation(tab('b','delete',$b))),'delete emptied tab');
check($db->items[$control]===$controlBefore&&$db->items[$controlContent]===$controlTextBefore,'unchanged block and content byte-identical');
foreach($db->writes as $write){check(!($write[0]!=='add'&&in_array($write[1],[$control,$controlContent],true)),'no unchanged object write calls');}
while(ob_get_level()){ob_end_clean();} echo "PASS: object CRUD/move, ownership, unchanged rows, idempotency/status, transactional rollback, commit uncertainty, legacy receipts\n";
}
