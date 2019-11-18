import MagicString from 'magic-string'
import { parseHtmlx } from './parser';
import { convertHtmlxToJsx } from './htmlxtojsx';
import { Node } from 'svelte/compiler'
import { createSourceFile, ScriptTarget, ScriptKind, SourceFile, SyntaxKind, VariableStatement, Identifier, FunctionDeclaration, BindingName, ExportDeclaration, ScriptSnapshot, LabeledStatement, ExpressionStatement, BinaryExpression } from 'typescript'


type SlotInfo = Map<string, Map<string, string>>;

export function AttributeValueAsJsExpression(htmlx: string, attr: Node): string {
    if (attr.value.length == 0) return "''"; //wut?

    //handle single value
    if (attr.value.length == 1) {
        let attrVal = attr.value[0];

        if (attrVal.type == "AttributeShorthand") {
            return attrVal.expression.name;
        }

        if (attrVal.type == "Text") {
            return '"' + attrVal.raw + '"';
        }

        if (attrVal.type == "MustacheTag") {
            return htmlx.substring(attrVal.expression.start, attrVal.expression.end)
        }
        throw Error("Unknown attribute value type:" + attrVal.type);
    }

    // we have multiple attribute values, so we build a string out of them. 
    // technically the user can do something funky like attr="text "{value} or even attr=text{value}
    // so instead of trying to maintain a nice sourcemap with prepends etc, we just overwrite the whole thing
    let valueParts = attr.value.map(n => {
        if (n.type == "Text") return '${"' + n.raw + '"}';
        if (n.type == "MustacheTag") return "$" + htmlx.substring(n.start, n.end);
    })
    let valuesAsStringTemplate = "`" + valueParts.join("") + "`";
    return valuesAsStringTemplate;
}





function processImports(str: MagicString, tsAst: SourceFile, astOffset: number, target: number) {
    for (var st of tsAst.statements) {
        if (st.kind == SyntaxKind.ImportDeclaration) {
            str.move(st.pos+astOffset, st.end+astOffset,target);
            str.overwrite(st.end+astOffset-1, st.end+astOffset, '"\n')
        }
    }
}


function removeStyleTags(str: MagicString, ast: Node) {
    for (var v of ast.children) {
        let n = v as Node;
        if (n.type == "Style") {
            str.remove(n.start, n.end);
        }
    }
}

function declareImplictReactiveVariables(declaredNames: string[], str: MagicString, tsAst: SourceFile, astOffset: number) {
    for (let le of tsAst.statements) {
        if (le.kind != SyntaxKind.LabeledStatement) continue;
        let ls = le as LabeledStatement;
        if (ls.label.text != "$") continue;
        if (!ls.statement || ls.statement.kind != SyntaxKind.ExpressionStatement) continue;
        let es = ls.statement as ExpressionStatement;
        if (!es.expression || es.expression.kind != SyntaxKind.BinaryExpression) continue;
        let be = es.expression as BinaryExpression;
        if (be.operatorToken.kind != SyntaxKind.EqualsToken
            || be.left.kind != SyntaxKind.Identifier) continue;

        let ident = be.left as Identifier;
        //are we already declared?
        if (declaredNames.find(n => ident.text == n)) continue;
        //add a declaration
        str.prependRight(ls.pos + astOffset + 1, `;let ${ident.text}; `)
    }
}

function replaceExports(str: MagicString, tsAst: SourceFile, astOffset: number) {
    //track a as b exports
    let exportedNames = new Map<string, string>();
    let declaredNames: string[] = [];

    const addDeclaredName = (name: BindingName) => {
        if (name.kind == SyntaxKind.Identifier) {
            declaredNames.push(name.text);
        }
    }

    const addExport = (name: BindingName, target: BindingName = null) => {
        if (name.kind != SyntaxKind.Identifier) {
            throw Error("export source kind not supported " + name)
        }
        if (target && target.kind != SyntaxKind.Identifier) {
            throw Error("export target kind not supported " + target)
        }
        exportedNames.set(name.text, target ? (target as Identifier).text : null);
    }

    const removeExport = (start: number, end: number) => {
        let exportStart = str.original.indexOf("export", start+astOffset);
        let exportEnd = exportStart + "export".length;
        str.remove(exportStart, exportEnd);
    }

    let statements = tsAst.statements;

    for (let s of statements) {
        if (s.kind == SyntaxKind.VariableStatement) {
            let vs = s as VariableStatement;
            let exportModifier = vs.modifiers
                ? vs.modifiers.find(x => x.kind == SyntaxKind.ExportKeyword)
                : null;
            if (exportModifier) {
                removeExport(exportModifier.pos, exportModifier.end);
            }
            for (let v of vs.declarationList.declarations) {
                if (exportModifier) {
                    addExport(v.name);
                }
                addDeclaredName(v.name);
            }
        }

        if (s.kind == SyntaxKind.FunctionDeclaration) {
            let fd = s as FunctionDeclaration;
            if (fd.modifiers) {
                let exportModifier = fd.modifiers.find(x => x.kind == SyntaxKind.ExportKeyword)
                if (exportModifier) {
                    addExport(fd.name)
                    removeExport(exportModifier.pos, exportModifier.end);
                }
            }
            addDeclaredName(fd.name);
        }

        if (s.kind == SyntaxKind.ExportDeclaration) {
            let ed = s as ExportDeclaration;
            for (let ne of ed.exportClause.elements) {
                if (ne.propertyName) {
                    addExport(ne.propertyName, ne.name)
                } else {
                    addExport(ne.name)
                }
                //we can remove entire modifier
                removeExport(ed.pos, ed.end);
            }
        }
    }

    return { exportedNames, declaredNames }
}

function findModuleScriptTag(str: MagicString, ast: Node ): Node {
    let script: Node = null;
    let htmlx = str.original;
    //find the script
    for (var v of ast.children) {
        let n = v as Node;
        if (n.type == "Script" && n.attributes && n.attributes.find(a => a.name == "context" && a.value.length == 1 && a.value[0].raw == "module")) {
            script = n;
            break;
        }
    }
    return script;
}


function processModuleScriptTag(str: MagicString, script: Node) {
    let htmlx = str.original;

    let scriptStartTagEnd = htmlx.indexOf(">", script.start)+1;
    let scriptEndTagStart = htmlx.lastIndexOf("<", script.end-1);
  
    str.overwrite(script.start, scriptStartTagEnd, "</>;");
    str.overwrite(scriptEndTagStart, script.end, ";<>");
}



function processScriptTag(str: MagicString, ast: Node, slots: SlotInfo, target: number) {
    let script: Node = null;

    //find the script
    for (var v of ast.children) {
        let n = v as Node;
        if (n.type == "Script" && n.attributes && !n.attributes.find(a => a.name == "context" && a.value.length == 1 && a.value[0].raw == "module")) {
            script = n;
        }
    }

    let slotsAsString = "{" + [...slots.entries()].map(([name, attrs]) => {
        let attrsAsString = [...attrs.entries()].map(([exportName, expr]) => `${exportName}:${expr}`).join(", ");
        return `${name}: {${attrsAsString}}`
    }).join(", ") + "}"


    let htmlx = str.original;

    if (!script) {
        str.prependRight(target, "</>;function render() {\n<>");
        str.append(";\nreturn { props: {}, slots: " + slotsAsString + " }}");
        return;
    }

    //move it to the top (the variables need to be declared before the jsx template)
    if (script.start != target) {
        str.move(script.start, script.end, target);
    }



    let tsAst = createSourceFile("component.ts.svelte", htmlx.substring(script.content.start, script.content.end), ScriptTarget.Latest, true, ScriptKind.TS);

    //I couldn't get magicstring to let me put the script before the <> we prepend during conversion of the template to jsx, so we just close it instead
    let scriptTagEnd = htmlx.lastIndexOf(">", script.content.start) + 1;
    //str.remove(script.start, script.start+1);
    str.overwrite(script.start, script.start+ 1, "</>;");
    str.overwrite(script.start+1, scriptTagEnd, "function render() {\n");

    let scriptEndTagStart = htmlx.lastIndexOf("<", script.end-1);
    str.overwrite(scriptEndTagStart, script.end, ";\n<>");


    let { exportedNames, declaredNames } = replaceExports(str, tsAst, script.content.start);

    declareImplictReactiveVariables(declaredNames, str, tsAst, script.content.start);

    let returnElements = [...exportedNames.entries()].map(([key, value]) => value ? `${value}: ${key}` : key);
    let returnString = "\nreturn { props: {" + returnElements.join(" , ") + "}, slots: " + slotsAsString + " }}"
    str.append(returnString)
    
    processImports(str, tsAst, script.content.start, script.start+1);

}


function addComponentExport(str: MagicString, uses$$props: boolean) {
    str.append(`\n\nexport default class {\n    $$prop_def = __sveltets_partial${ uses$$props ? "_with_any" : "" }(render().props)\n    $$slot_def = render().slots\n}`);
}




export function svelte2tsx(svelte: string) {

    let str = new MagicString(svelte);
    let htmlxAst = parseHtmlx(svelte);

    let uses$$props = false;
    const handleIdentifier = (node: Node) => {
        if (node.name == "$$props") {
            uses$$props = true; 
            return;
        }
    }
    
    let slots = new Map<string, Map<string, string>>();
    const handleSlot =  (node) => {
        let nameAttr = node.attributes.find(a => a.name == "name");
        let slotName = nameAttr ? nameAttr.value[0].raw : "default";
        //collect attributes
        let attributes = new Map<string, string>();
        for (let attr of node.attributes) {
            if (attr.name == "name") continue;
            if (!attr.value.length) continue;
            attributes.set(attr.name, AttributeValueAsJsExpression(svelte, attr));
        }
        slots.set(slotName, attributes)
    }    


    const onHtmlxWalk = (node:Node, parent:Node) => {
        if (node.type == "Identifier") {
            handleIdentifier(node);
        } else if (node.type == "Slot") {
            handleSlot(node);
        }
    }

    convertHtmlxToJsx(str, htmlxAst, onHtmlxWalk)

    removeStyleTags(str, htmlxAst);
   
    let moduleScript = findModuleScriptTag(str, htmlxAst);
      //move it to the top
    if (moduleScript && moduleScript.start != 0) {
        str.move(moduleScript.start, moduleScript.end, 0);
    }
    let moveScriptTarget = (moduleScript && moduleScript.start == 0) ? moduleScript.end : 0;
    processScriptTag(str, htmlxAst, slots, moveScriptTarget);

    if (moduleScript) {
        processModuleScriptTag(str, moduleScript);
    }
    
    addComponentExport(str, uses$$props);
    
    return {
        code: str.toString(),
        map: str.generateMap({ hires: true })
    }
}